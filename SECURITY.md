# Security policy

## Supported versions

Only the latest release on npm (`pi-context-guard`) gets fixes.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**.

Include the version, your Pi version, what you observed and how to reproduce it. You can expect a first answer within a week.

Both extensions run inside your Pi session with its permissions. `context-guard` runs the `engram` CLI to save summaries, and `context-observer` writes metrics (never conversation content) to a local file. Reports about either of these paths are especially welcome.
