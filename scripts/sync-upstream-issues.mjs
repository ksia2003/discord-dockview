/*
 * Fail-closed GitHub issue synchronisation for upstream maintenance.
 *
 * The workflow used to turn a failed `gh | jq` enumeration into an empty list,
 * then create a duplicate tracker. This helper completes enumeration before
 * making any issue mutation and uses the GitHub API directly, so a gh/jq
 * formatting failure cannot be mistaken for "no issue exists".
 */

import { readFileSync } from "fs";

const API_ROOT = "https://api.github.com";
const TRACKER_LABEL = "upstream-maintenance";
const OVERDUE_LABEL = "upstream-overdue";
export const AUTOMATION_MARKER = "<!-- dockview-upstream-maintenance:managed -->";
const TITLES = {
    vencord: "[upstream] Vencord stable update pending",
    vesktop: "[upstream] Vesktop changes require review",
    failure: "[upstream] upstream maintenance automation failed"
};

function apiRoot() {
    return process.env.UPSTREAM_API_ROOT || API_ROOT;
}

function repository() {
    const value = process.env.GITHUB_REPOSITORY;
    if (!value || !/^[^/]+\/[^/]+$/.test(value)) throw new Error("GITHUB_REPOSITORY is missing or invalid");
    return value;
}

function token() {
    const value = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!value) throw new Error("GH_TOKEN/GITHUB_TOKEN is missing");
    return value;
}

function headers() {
    return {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token()}`,
        "User-Agent": "DockView-Upstream-Maintenance",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
    };
}

async function request(method, path, body) {
    const response = await fetch(`${apiRoot()}${path}`, {
        method,
        headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let value = null;
    if (text) {
        try {
            value = JSON.parse(text);
        } catch {
            throw new Error(`GitHub API ${method} ${path} returned invalid JSON`);
        }
    }
    if (!response.ok) {
        const detail = value?.message || text || `HTTP ${response.status}`;
        throw new Error(`GitHub API ${method} ${path} failed: ${detail}`);
    }
    return value;
}

async function listOpenIssues() {
    const all = [];
    const repo = repository();
    for (let page = 1; page <= 20; page++) {
        // Enumerate all open issues instead of trusting the automation label:
        // a partially failed label write must not hide an existing exact-title
        // tracker and cause a duplicate create.
        const query = new URLSearchParams({ state: "open", per_page: "100", page: String(page) });
        const batch = await request("GET", `/repos/${repo}/issues?${query}`);
        if (!Array.isArray(batch)) throw new Error("GitHub issues response was not an array");
        all.push(...batch.filter(issue => !issue.pull_request));
        if (batch.length < 100) return all;
    }
    throw new Error("GitHub issues enumeration exceeded the 20-page safety limit");
}

async function ensureLabel(name, description, color) {
    const repo = repository();
    const encoded = encodeURIComponent(name);
    const existing = await request("GET", `/repos/${repo}/labels/${encoded}`).catch(error => {
        if (/HTTP 404|failed: Not Found/i.test(error.message)) return null;
        throw error;
    });
    if (existing) return;
    try {
        await request("POST", `/repos/${repo}/labels`, { name, description, color });
    } catch (error) {
        // A concurrent run may have won the create race. Confirm it exists;
        // never proceed as if a failed label write succeeded.
        await request("GET", `/repos/${repo}/labels/${encoded}`);
    }
}

function matchingIssues(issues, title) {
    return issues
        .filter(issue => issue.title === title && typeof issue.body === "string" && issue.body.split(/\r?\n/).includes(AUTOMATION_MARKER))
        .sort((a, b) => a.number - b.number);
}

function managedBody(body) {
    return body.startsWith(AUTOMATION_MARKER) ? body : `${AUTOMATION_MARKER}\n\n${body}`;
}

async function comment(issueNumber, body) {
    await request("POST", `/repos/${repository()}/issues/${issueNumber}/comments`, { body });
}

async function closeIssue(issueNumber, body) {
    await comment(issueNumber, body);
    await request("PATCH", `/repos/${repository()}/issues/${issueNumber}`, { state: "closed" });
}

async function setLabels(issue, names) {
    await request("PUT", `/repos/${repository()}/issues/${issue.number}/labels`, { labels: [...new Set(names)] });
}

async function syncTracker({ issues, title, active, body, closeComment, specificLabel }) {
    const matches = matchingIssues(issues, title);
    const canonical = matches[0];

    // Enumeration is complete before this point. Only now may automation
    // close duplicates or create an issue.
    for (const duplicate of matches.slice(1)) {
        await closeIssue(duplicate.number, `Closing duplicate automated upstream tracker; #${canonical.number} is canonical.`);
    }

    if (!active) {
        if (canonical) await closeIssue(canonical.number, closeComment);
        return;
    }

    let issue = canonical;
    const bodyWithMarker = managedBody(body);
    if (issue) {
        await request("PATCH", `/repos/${repository()}/issues/${issue.number}`, { body: bodyWithMarker });
    } else {
        issue = await request("POST", `/repos/${repository()}/issues`, {
            title,
            body: bodyWithMarker,
            labels: [TRACKER_LABEL, specificLabel]
        });
    }

    const created = Date.parse(issue.created_at);
    const overdue = Number.isFinite(created) && Date.now() - created >= 7 * 86400000;
    const labels = [TRACKER_LABEL, specificLabel, ...(overdue ? [OVERDUE_LABEL] : [])];
    await setLabels(issue, labels);
}

async function syncFailure({ issues, body }) {
    const title = TITLES.failure;
    const matches = matchingIssues(issues, title);
    const canonical = matches[0];
    for (const duplicate of matches.slice(1)) {
        await closeIssue(duplicate.number, `Closing duplicate automated failure tracker; #${canonical.number} is canonical.`);
    }
    let issue = canonical;
    const bodyWithMarker = managedBody(body);
    if (issue) {
        await request("PATCH", `/repos/${repository()}/issues/${issue.number}`, { body: bodyWithMarker });
    } else {
        issue = await request("POST", `/repos/${repository()}/issues`, {
            title,
            body: bodyWithMarker,
            labels: [TRACKER_LABEL, OVERDUE_LABEL]
        });
    }
    await setLabels(issue, [TRACKER_LABEL, OVERDUE_LABEL]);
}

function reportBody(path) {
    return readFileSync(path, "utf-8");
}

function configuredBody() {
    if (process.env.UPSTREAM_REPORT) return reportBody(process.env.UPSTREAM_REPORT);
    if (process.env.UPSTREAM_FAILURE_BODY) return process.env.UPSTREAM_FAILURE_BODY;
    throw new Error("UPSTREAM_REPORT or UPSTREAM_FAILURE_BODY is required");
}

async function main() {
    const mode = process.argv[2];
    if (!mode || !["sync", "failure"].includes(mode)) throw new Error("Usage: sync-upstream-issues.mjs <sync|failure>");
    const issues = await listOpenIssues();
    if (mode === "failure") {
        await ensureLabel(TRACKER_LABEL, "Automated upstream maintenance", "1d76db");
        await ensureLabel(OVERDUE_LABEL, "Upstream automation failure or review overdue", "b60205");
        await syncFailure({ issues, body: configuredBody() });
        return;
    }

    await ensureLabel(TRACKER_LABEL, "Automated upstream maintenance", "1d76db");
    await ensureLabel("upstream-vencord", "Vencord stable update candidate", "0e8a16");
    await ensureLabel("upstream-vesktop", "Vesktop upstream review", "5319e7");
    await ensureLabel(OVERDUE_LABEL, "Upstream automation failure or review overdue", "b60205");
    const body = configuredBody();
    await syncTracker({
        issues,
        title: TITLES.vencord,
        active: process.env.VENCORD_UPDATE === "true",
        body,
        specificLabel: "upstream-vencord",
        closeComment: "The pinned Vencord tag, commit, and verified bundle now match the monitored stable upstream."
    });
    await syncTracker({
        issues,
        title: TITLES.vesktop,
        active: process.env.VESKTOP_UPDATE === "true",
        body,
        specificLabel: "upstream-vesktop",
        closeComment: "The monitored Vesktop release and source head have been reviewed. The bundled version may intentionally differ from the review cursor."
    });
}

if (process.argv[1] && process.argv[1].endsWith("sync-upstream-issues.mjs")) {
    main().catch(async error => {
        console.error(error instanceof Error ? error.stack : String(error));
        if (process.argv[2] === "sync" && process.env.UPSTREAM_REPORT) {
            try {
                // A failure issue is best effort. Its own full enumeration still
                // happens before any create/update, so an API outage cannot make
                // this fallback duplicate the durable tracker.
                const issues = await listOpenIssues();
                await ensureLabel(TRACKER_LABEL, "Automated upstream maintenance", "1d76db");
                await ensureLabel(OVERDUE_LABEL, "Upstream automation failure or review overdue", "b60205");
                await syncFailure({
                    issues,
                    body: `${reportBody(process.env.UPSTREAM_REPORT)}\n\nAutomation error:\n\n${error.message}`
                });
            } catch (fallbackError) {
                console.error(`Could not create durable failure issue: ${fallbackError.message}`);
            }
        }
        process.exitCode = 1;
    });
}
