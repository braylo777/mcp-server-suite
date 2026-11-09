import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.2.0", 24, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.51.100.0", 24, "ipv4");
blocked.addSubnet("203.0.113.0", 24, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addSubnet("240.0.0.0", 4, "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");

const BLOCKED_NAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata.internal"]);

export type AddressClass = "public" | "private_or_reserved";

/**
 * True for loopback, private, link-local, CGNAT, multicast, reserved, and
 * documentation ranges, plus IPv4-mapped forms of those. Public DNS answers
 * such as 1.1.1.1 and 8.8.8.8 are false.
 */
export function isBlockedAddress(address: string): boolean {
  const unmapped = unwrapMapped(address);
  if (isIP(unmapped) === 4) return blocked.check(unmapped, "ipv4");
  if (isIP(address) === 6) return blocked.check(address, "ipv6");
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_NAMES.has(name)) return true;
  if (name.endsWith(".localhost")) return true;
  return false;
}

function unwrapMapped(address: string): string {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return lower.slice("::ffff:".length);
  return address;
}
