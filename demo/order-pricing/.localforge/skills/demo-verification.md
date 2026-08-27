# Test-first demo verification

Inspect both the implementation and the existing acceptance tests before editing.
Run `pnpm test` once to capture the real failing baseline, then make the smallest
correct change without weakening or deleting tests. Run the same command again
and report its exit result. Keep the exported function name unchanged.
