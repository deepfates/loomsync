# lync-server

The lync line-sync relay. Run it standalone with `startLyncServe`, or embed it
in an existing Node HTTP server with `createLyncRelay` and call `handleUpgrade`
from your own `upgrade` listener. It stores each root as a plain append-only
`.lync` file and never parses a line beyond its id. See
https://github.com/deepfates/lync.
