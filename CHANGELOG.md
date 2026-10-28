# Changelog

## 0.1.0

- Initial extraction of the engineering workflow from a personal Pi setup.
- Plan, architecture, implementation, and verify phases with mechanical gates.
- Contract hashes cover approved plan, architecture, and project config.
- Git-based change detection with fail-closed behavior when git is unavailable.
- Revision budget and `BLOCKED` escalation.
- `/eng verify` and `/eng audit` require explicit human confirmation before
  executing project-configured commands; headless use fails closed unless
  `PI_ENGINEERING_ALLOW_COMMANDS=1` is set by the user.
- Per-project model fallback chains via `phase_models`.
- Optional external quality audit integration; no hard-coded personal paths.
- Pure gate tests and end-to-end regression tests with a fake Pi API.
