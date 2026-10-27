# Messenger native helper

The private native helper uses `go.mau.fi/mautrix-meta v0.2610.0` and its Go dependencies. Mautrix-meta is licensed under AGPL-3.0; its license is included in `native/messenger/LICENSE.mautrix.txt`. Helper source, pinned dependencies and modifications are retained in `native/messenger/`. No installed Sendy code or binary is included. The helper now includes messaging sockets, explicit approved message operations, opt-in read receipts, E2EE device storage, PIN-based history recovery and encrypted-message transport. Whatsmeow is used under its MPL-2.0 license; encrypted SQLite uses ncruces go-sqlite3 and lukechampine Adiantum. Their license files are retained under native/messenger/. Any future distribution must include the applicable corresponding source and dependency notices.

# Instagram read-protocol reference

The persisted GraphQL read-query formats and authentication field mapping were adapted with reference to [Aerogram](https://github.com/charindithjaindu/aerogram), `aerogram/http_api.py`, `aerogram/types.py`, and `docs/protocol.md` (retrieved 2026-10-27). Reads and mutations use separate allowlists. Text/media sending and mark-read formats refer to Aerogram. Instagram edit, unsend and reaction formats also refer to mautrix-meta v0.2610.0 / commit 3c16226 (Tulir Asokan, AGPL-3.0-or-later); the applicable license is included alongside the native helper source.

MIT License

Copyright (c) 2026 Aerogram contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
