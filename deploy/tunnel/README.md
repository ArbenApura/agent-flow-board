# Public preview through a Cloudflare tunnel

`https://agent-flow-board.arbenger.com` reaches the build preview on this PC (port 5190), on the local Docker PostgreSQL (127.0.0.1:5433). Dev stays on 5180.

- `start.ps1` starts Docker, builds, and runs `vite preview` on 127.0.0.1:5190. Logs are in `.afb/`.
- `tunnel.ps1` runs the `afb` tunnel (`~/.cloudflared/afb.yml`) to that port. Its log is `deploy/tunnel/tunnel.log`.
- Logon start: copy `AFB Preview.cmd` and `AFB Tunnel.cmd` into `shell:startup`.
- The demo seed is off here. Demo accounts must not exist in this database: their password is public in the README.
