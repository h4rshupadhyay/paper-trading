#!/bin/sh
set -eu
# One IPv4 CIDR, never wildcard trust. Invalid values stop nginx startup.
if ! printf '%s\n' "$TRUSTED_INGRESS_CIDR" | awk '
  BEGIN { FS="/"; valid=0 }
  NF == 2 && $2 ~ /^[0-9]+$/ && $2 >= 1 && $2 <= 32 {
    count=split($1, octets, ".")
    if (count != 4) next
    for (i=1; i<=4; i++)
      if (octets[i] !~ /^[0-9]+$/ || octets[i] > 255) next
    valid=1
  }
  END { exit !(NR == 1 && valid) }
'; then
  echo 'TRUSTED_INGRESS_CIDR must be one IPv4 CIDR with a prefix from 1 to 32; wildcard trust is forbidden' >&2
  exit 1
fi
