# port-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Keeps one session from taking or killing a dev server port that another Claude session is using. This is the most common collision when several worktrees of one app run `npm run dev`.

## Starting a dev server on a taken port

### Which commands it reads

`npm run dev` and the same through pnpm, yarn and bun, `next dev`, `vite`, `astro dev`, `nuxt dev`, `remix dev`, `expo start`, `python -m http.server`, `uvicorn`, `flask run`, `rails s`, `manage.py runserver`, `ng serve`, `php artisan serve` and a few more.

It works out the port from `--port`, `-p`, `PORT=` (for tools that read it) or the tool's default, following package.json scripts. If another Claude session's process tree is listening on that port, the call is blocked.

### Why

Next.js and Vite move to the next free port on their own, so nothing fails, but the agent keeps testing `localhost:3000` and sees the other worktree's branch. The usual next step is to stop "whatever is on 3000".

### What Claude sees

```
[bulkhead] port-guard: port 3000 is already used by another Claude session (session pid 18672, ~/src/acme-web): node.exe pid 24632.
Leave that server alone; it is the other session's work. If you start yours anyway, it either fails or moves to the next port, and requests to localhost:3000 reach the other project.
Port 3001 is free:
  npm run dev -- --port 3001
```

When it cannot find a free port itself, the last line says to pick one and that `bulkhead port --near 3000` prints one.

### Allowed

- The same session reusing its own port.
- A port held by a program outside Claude.
- A command whose port it cannot work out, such as `--port $PORT`.

## Killing a server by port

kill-guard lets kills by port through, because a port usually names one server. But if that server belongs to another session, killing it by port does the same damage as killing it by name. port-guard blocks these when the port is held by another live Claude session:

```
npx kill-port 3000                       # also several ports, and --port 3000,3001
fuser -k 3000/tcp                        # and fuser -k -n tcp 3000
lsof -t -i:3000 | xargs kill             # lsof output fed to kill or xargs kill
kill $(lsof -t -i:3000)                  # and the backtick form
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force
for /f "tokens=5" %a in ('netstat -aon ^| findstr :3000') do taskkill /F /PID %a
```

```
[bulkhead] port-guard: `npx kill-port 3000` would stop node.exe pid 24632, the server another Claude session runs on port 3000 (session pid 18672, ~/src/acme-web).
That server is the other session's work. Stopping it breaks whatever that session is running or testing.
If you need a server of your own, start it on a free port instead: 3001 is free.
`bulkhead port --near 3000` prints a port no session holds.
To stop a process you started yourself, stop it by its PID.
```

These pass: your own session's port, a port held by a program outside Claude, a port whose owner it cannot tell, and a port nothing listens on (then it does not scan processes at all). Looking up a port is never blocked: `lsof -ti :3000` and `netstat -ano | findstr :3000` on their own pass.

## Finding a free port

`bulkhead port --near 3000` prints the first port at or above 3000 that binds on `127.0.0.1`, `0.0.0.0`, `::1` and `::`, skipping ports browsers refuse. It prints only the number, so it works inline:

```
npm run dev -- --port $(bulkhead port --near 3000)
```

See [commands](../commands.md#bulkhead-port).

## Cost

It reads the process list only when the command starts a dev server or kills by port and something already answers on that port. To check, it tries a TCP connection to `localhost`, which takes a few milliseconds. On an everyday command it costs about the same as starting Node.

## Turn off or tune

- `BULKHEAD_DISABLE=port-guard`, or `"portGuard": { "enabled": false }` in a config file, turns it off.
- `portGuard.ignorePorts` lists ports it never checks, such as a debugger port every session shares on purpose: `[9229]`.

See [configuration](../configuration.md).

## Limits

- The dev server list is fixed. Wrappers such as `bash -c`, `cmd /c`, `powershell -Command`, `sudo` and `env PORT=3000` are opened, as in kill-guard.
- Ports set in a config file such as `vite.config.ts` are not seen, so the tool's default is assumed.
