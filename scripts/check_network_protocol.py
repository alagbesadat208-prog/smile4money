#!/usr/bin/env python3
"""Read-only Stellar RPC protocol identity preflight. No external modules."""
import json
import sys
import urllib.request
import urllib.error

NETWORKS = {
    'testnet': ('https://soroban-testnet.stellar.org', 'Test SDF Network ; September 2015'),
    'mainnet': ('https://soroban-mainnet.stellar.org', 'Public Global Stellar Network ; September 2015'),
}


def method(endpoint, method_name):
    request = urllib.request.Request(endpoint, data=json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': method_name
    }).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=6) as result:
        data = json.load(result)
    if not isinstance(data, dict) or not isinstance(data.get('result'), dict) or data.get('error'):
        raise ValueError('Malformed JSON-RPC result')
    return data['result']


def validate(network, major, get):
    if network not in NETWORKS:
        raise ValueError('Unsupported network label')
    url, expected_passphrase = NETWORKS[network]
    identity = get(url, 'getNetwork')
    if identity.get('passphrase') != expected_passphrase:
        raise ValueError('RPC network passphrase mismatch')
    latest = get(url, 'getLatestLedger')
    protocol = latest.get('protocolVersion')
    if not isinstance(protocol, int) or isinstance(protocol, bool) or protocol < 22:
        raise ValueError('RPC returned missing/unsupported protocol version')
    if major < protocol:
        raise ValueError(f'Stellar CLI major {major} is older than active network protocol {protocol}')
    return protocol


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Expected network name and CLI major')
        actual = validate(sys.argv[1], int(sys.argv[2]), method)
        print(f'Read-only network protocol preflight passed ({sys.argv[1]}, protocol {actual}).')
    except (ValueError, OSError, urllib.error.URLError) as exc:
        print('NETWORK PROTOCOL CHECK FAILED: ' + str(exc), file=sys.stderr)
        raise SystemExit(1)
