# HTTPS ingress and client addresses

For public deployment, terminate HTTPS at your edge and retain the bundled nginx as the only route to the private API. Set `NODE_ENV=production` and `PUBLIC_ORIGIN=https://your-domain.example`. Keep the web port bound to loopback when the edge runs on the host. Do not publish the API port; its `TRUST_PROXY_HOPS=1` trusts only the bundled nginx.

By default nginx trusts forwarded client addresses only from `127.0.0.1/32`. A request from any other peer has its `X-Forwarded-For` replaced with the actual TCP peer address. This preserves safe direct local use. With an additional HTTPS edge, explicitly configure the address nginx actually sees for that edge:

```dotenv
# In .env.pern-compose.local; replace with your actual ingress source CIDR.
TRUSTED_INGRESS_CIDR=192.0.2.10/32
```

This example address is documentation only. Use the narrowest source range, preferably the edge's fixed IPv4 address with `/32`. Docker may present the host bridge gateway rather than `127.0.0.1` for a host edge. Determine that source from your network configuration; do not guess a whole Docker subnet. An ingress container should have a stable source address on a private network. Restrict access to the web port so only the intended edge can reach it in public deployments.

The setting accepts one IPv4 CIDR with prefix `/1` through `/32`. Empty Compose values use the safe loopback default. Wildcards, `/0`, malformed values, and IPv6 are rejected at nginx startup. IPv6 ingress sources require a separately reviewed trust configuration. Never trust all clients, a shared public network, or a broad range merely to make forwarding work.

Configure your HTTPS edge to **overwrite** `X-Forwarded-For` with the client address it observes, rather than accepting a caller-supplied address. For an nginx HTTPS edge, the forwarding portion of its TLS server can be:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Configure certificates and TLS policy at that edge. The bundled nginx uses a trusted edge's rightmost untrusted forwarded address as the client, then sends exactly that single address to the API. Two clients behind the edge consequently have different authentication limiter keys; an untrusted direct peer cannot choose its key by supplying a forwarded header. The API remains configured for exactly one proxy hop. Do not increase that hop count for this topology. Authentication limits remain per process; use a shared limiter before adding API replicas.

After updating the environment, rebuild and recreate the web service using the same project and data volume as your deployment:

```bash
docker compose --env-file .env.pern-compose.local up --build --detach --no-deps web
```

The ingress regression test builds the actual web image, then checks trusted clients, untrusted spoofing, default trust, and invalid trust startup through disposable containers. It creates a uniquely named network and image and uses no database, credentials, or volumes:

```bash
python3 -m unittest discover -s deploy/pern/test -p test_ingress.py -v
```

Docker must be running and able to obtain the build images plus `node:20-alpine` for the HTTP probe. The test verifies the address delivered to the API boundary; the API's authentication limiter is tested separately. It does not provision certificates or contact your real ingress.
