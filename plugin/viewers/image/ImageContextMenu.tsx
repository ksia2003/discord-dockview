import { ContextMenuApi, Menu, React } from "@vencord/types/webpack/common";

import { STRINGS } from "../../strings";
import { copyOriginalImage, saveOriginalImage } from "./actions";

export function ImageContextMenu({ url, name }: { url: string; name: string | null; }) {
    return React.createElement(
        Menu.Menu,
        { navId: "dockview-image-context", onClose: ContextMenuApi.closeContextMenu },
        React.createElement(
            Menu.MenuGroup,
            null,
            React.createElement(Menu.MenuItem, {
                id: "dockview-image-copy",
                label: STRINGS.menu.copyImage,
                action: () => copyOriginalImage(url)
            }),
            React.createElement(Menu.MenuItem, {
                id: "dockview-image-save",
                label: STRINGS.menu.saveImage,
                action: () => saveOriginalImage(url, name)
            })
        )
    );
}
