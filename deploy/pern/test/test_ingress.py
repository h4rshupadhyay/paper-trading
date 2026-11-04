"""Real built nginx ingress contract; requires Docker, never uses application data.

Run: python3 -m unittest discover -s deploy/pern/test -p test_ingress.py -v
Creates only uniquely named containers/network/image, all removed in cleanup.
The API probe returns the forwarded client address consumed by the API's one-hop
proxy trust. No database, credentials, volumes or running stack are involved.
"""
import ipaddress
import json
from pathlib import Path
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
CLIENT_IMAGE = 'node:20-alpine'


def docker(*args, check=True, timeout=180):
    result = subprocess.run(['docker', *args], cwd=ROOT, capture_output=True,
                            text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    return result


class IngressTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prefix = 'paper-ingress-test-' + uuid.uuid4().hex[:12]
        cls.network = cls.prefix + '-network'
        cls.image = cls.prefix + ':test'
        cls.containers = []
        cls.addClassCleanup(cls.cleanup)
        docker('build', '-f', 'deploy/pern/web.Dockerfile', '-t', cls.image, '.', timeout=600)
        docker('network', 'create', cls.network)
        info = json.loads(docker('network', 'inspect', cls.network).stdout)[0]
        subnet = ipaddress.ip_network(info['IPAM']['Config'][0]['Subnet'])
        # Docker 28 rejects static client IPs on automatically allocated subnets.
        # Let IPAM choose an unused range, then explicitly configure that range.
        # No containers have joined this uniquely named test network yet.
        docker('network', 'rm', cls.network)
        docker('network', 'create', '--subnet', str(subnet), cls.network)
        cls.trusted_ip = str(subnet.network_address + 10)
        cls.untrusted_ip = str(subnet.network_address + 11)
        cls.start('api', CLIENT_IMAGE, ['node', '-e',
            "require('http').createServer((q,s)=>s.end(q.headers['x-forwarded-for']||''))"
            ".listen(3001,'0.0.0.0')"], alias='api')

    @classmethod
    def cleanup(cls):
        for name in reversed(cls.containers):
            docker('rm', '-f', name, check=False)
        docker('network', 'rm', cls.network, check=False)
        docker('image', 'rm', cls.image, check=False)

    @classmethod
    def start(cls, suffix, image, command=(), alias=None, env=()):
        name = cls.prefix + '-' + suffix
        cls.containers.append(name)
        args = ['run', '-d', '--name', name, '--network', cls.network]
        if alias:
            args += ['--network-alias', alias]
        for value in env:
            args += ['-e', value]
        docker(*args, image, *command)
        return name

    def request(self, web, peer, forwarded):
        script = ("fetch('http://" + web + "/api/probe',{headers:" +
                  json.dumps({'X-Forwarded-For': forwarded}) +
                  "}).then(async r=>{if(!r.ok)throw Error(r.status);"
                  "process.stdout.write(await r.text())}).catch(e=>{console.error(e);process.exit(1)})")
        # One request per disposable client, using the chosen real TCP source.
        return docker('run', '--rm', '--network', self.network, '--ip', peer,
                      CLIENT_IMAGE, 'node', '-e', script, check=False)

    def await_web(self, web):
        for _ in range(40):
            result = self.request(web, self.trusted_ip, '198.51.100.7')
            if result.returncode == 0:
                return
            time.sleep(.25)
        logs = docker('logs', web, check=False)
        self.fail('nginx never became ready. Last client exit=' + str(result.returncode)
                  + '\nclient stderr: ' + result.stderr + '\nclient stdout: ' + result.stdout
                  + '\nnginx stderr: ' + logs.stderr + '\nnginx stdout: ' + logs.stdout)

    def test_only_explicit_trusted_ingress_can_preserve_forwarded_clients(self):
        web = self.start('trusted-web', self.image,
                         env=['TRUSTED_INGRESS_CIDR=' + self.trusted_ip + '/32'])
        self.await_web(web)
        first = self.request(web, self.trusted_ip, '198.51.100.99, 198.51.100.7')
        second = self.request(web, self.trusted_ip, '198.51.100.8')
        spoof = self.request(web, self.untrusted_ip, '198.51.100.7')
        for result in (first, second, spoof):
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(first.stdout, '198.51.100.7')
        self.assertEqual(second.stdout, '198.51.100.8')
        self.assertEqual(spoof.stdout, self.untrusted_ip)

    def test_default_direct_access_ignores_spoofed_client_headers(self):
        web = self.start('default-web', self.image)
        self.await_web(web)
        response = self.request(web, self.trusted_ip, '198.51.100.7')
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(response.stdout, self.trusted_ip)

    def test_wildcard_or_invalid_trust_fails_before_serving(self):
        for index, cidr in enumerate(('0.0.0.0/0', '0.0.0.0/00', '*',
                                       '256.1.1.1/32', '127.0.0.1/33')):
            with self.subTest(cidr=cidr):
                web = self.start('invalid-' + str(index), self.image,
                                 env=['TRUSTED_INGRESS_CIDR=' + cidr])
                for _ in range(40):
                    status = docker('inspect', '-f', '{{.State.Status}}', web).stdout.strip()
                    if status == 'exited':
                        break
                    time.sleep(.1)
                self.assertEqual(status, 'exited', 'invalid trust must stop startup')
                code = docker('inspect', '-f', '{{.State.ExitCode}}', web).stdout.strip()
                self.assertNotEqual(code, '0')


if __name__ == '__main__':
    unittest.main()
