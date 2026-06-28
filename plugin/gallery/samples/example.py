"""Sieve of Eratosthenes — a small, real Python sample for the DockView viewer."""
from __future__ import annotations
from dataclasses import dataclass


@dataclass
class Primes:
    limit: int

    def sieve(self) -> list[int]:
        flags = [True] * (self.limit + 1)
        flags[0:2] = [False, False]
        for n in range(2, int(self.limit ** 0.5) + 1):
            if flags[n]:
                for multiple in range(n * n, self.limit + 1, n):
                    flags[multiple] = False
        return [i for i, is_prime in enumerate(flags) if is_prime]


if __name__ == "__main__":
    primes = Primes(50).sieve()
    print(f"{len(primes)} primes <= 50: {primes}")
