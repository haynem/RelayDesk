# Development instructions

- This is a private, unfinished application for the user's personal use. Do not publish, push to a remote, redistribute Sendy code, contract paid services, or create chargeable infrastructure without the user's explicit approval.
- Never modify the installed Sendy application, its settings, account files, message stores, or authentication material. Reference extraction lives outside this repository.
- Never send a message, edit/delete remote content, mute/block an account, or change external account settings during testing without approval of the concrete action. Use synthetic fixtures for automated tests.
- Credentials, session cookies, keys, and personal messages belong only in the application's OS-protected encrypted data store. Never print them, add them to Git, or include them in screenshots.
- Human login and two-factor authentication happen in the service's official window. Do not ask for passwords or OTPs in chat.
- Keep code implementation, synthetic test results, live-service results, and physical-device results separate in docs/progress.md. Never call a fixture an actual integration success.
- Run npm.cmd test after substantive TypeScript changes. Run Electron UI smoke after UI or startup changes. Android builds require a proper JDK/SDK; do not claim success from TypeScript tests.
- The user's initial live target is Instagram. Prioritize real, read-only DM retrieval and read-receipt verification after the user logs in, then improve history synchronization before adding more services.
