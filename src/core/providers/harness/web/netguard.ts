/**
 * Where the web tool may connect. The model chooses the URL, and page text
 * can talk it into choosing another, so an address is judged by what it is:
 * this machine (allowed: a dev server the model started is the common case),
 * the local network, link-local and cloud-metadata ranges (refused unless the
 * user opted in, metadata never), or the public internet. Names are judged by
 * the addresses they resolve to, at the moment of connecting, so a name that
 * points inward cannot get past a check made on the name.
 */
import dns from "node:dns";
import net from "node:net";

export type AddressClass = "public" | "loopback" | "private" | "linklocal" | "metadata" | "unspecified";

function ipv4Class(parts: readonly number[]): AddressClass {
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 169 && b === 254) return c === 169 && parts[3] === 254 ? "metadata" : "linklocal";
  // Alibaba Cloud's metadata service, inside the shared range below.
  if (a === 100 && b === 100 && c === 100 && parts[3] === 200) return "metadata";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  // Carrier-grade NAT, the shared range some clouds and VPNs use for their own services.
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 192 && b === 0 && c === 0) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "private";
  // Multicast and reserved.
  if (a >= 224) return "unspecified";
  return "public";
}

/** Expand an IPv6 literal to its eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  // A dotted tail (::ffff:1.2.3.4) is two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    text = `${text.slice(0, -dotted[1]!.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** What kind of place an IP address is. Anything that does not parse is treated as the most restricted kind. */
export function classifyAddress(address: string): AddressClass {
  const family = net.isIP(address.split("%")[0]!);
  if (family === 4) return ipv4Class(address.split(".").map(Number));
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (groups === null) return "unspecified";
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
    if (groups.every((group, index) => group === 0 || index === 7)) return g7 === 1 ? "loopback" : g7 === 0 ? "unspecified" : "public";
    // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form: judge the IPv4 address inside.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return ipv4Class([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
    // NAT64 (64:ff9b::/96) embeds an IPv4 address the same way.
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Class([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
    if ((g0 & 0xfe00) === 0xfc00) return g0 === 0xfd00 && g1 === 0x0ec2 ? "metadata" : "private";
    if ((g0 & 0xffc0) === 0xfe80) return "linklocal";
    if ((g0 & 0xff00) === 0xff00) return "unspecified";
    return "public";
  }
  return "unspecified";
}

export interface NetworkPolicy {
  /** Let the local network (10/8, 192.168/16 and the like) through. This machine always is; cloud metadata addresses never are. */
  readonly allowPrivate: boolean;
}

/** Why a connection to this kind of address is refused, or null when it may go ahead. */
export function refusalFor(kind: AddressClass, policy: NetworkPolicy): string | null {
  switch (kind) {
    case "public":
    case "loopback":
      return null;
    case "private":
      return policy.allowPrivate ? null : "That address is on a private network. The web tool only reaches this machine and the public internet; allow 'Web tools reach private networks' (web.privateNetwork) in the settings if you mean to.";
    case "linklocal":
      return policy.allowPrivate ? null : "That address is link-local, which is where cloud metadata services and some local devices live. It is refused unless 'Web tools reach private networks' (web.privateNetwork) is on in the settings.";
    case "metadata":
      return "That address is a cloud metadata service. It is never reached by the web tool.";
    case "unspecified":
      return "That is not an address a web page can be fetched from.";
  }
}

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

/** Whether a host name or literal is this machine, judged by the name alone (no lookup): what the tool treats as needing no approval. */
export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  return net.isIP(name) !== 0 && classifyAddress(name) === "loopback";
}

type LookupFunction = typeof dns.lookup;

/**
 * Resolve a host name and pick the address to connect to, refusing if any
 * address it resolves to is one the policy forbids. The caller connects to
 * the address returned here and to nothing it looks up again, so there is no
 * gap between the check and the connection for a name to change its answer in.
 */
export async function resolveAllowed(hostname: string, policy: NetworkPolicy, resolve: LookupFunction = dns.lookup): Promise<{ address: string; family: 4 | 6 }> {
  const name = hostname.replace(/^\[|\]$/g, "");
  const literal = net.isIP(name);
  if (literal !== 0) {
    const refusal = refusalFor(classifyAddress(name), policy);
    if (refusal !== null) throw new BlockedAddressError(refusal);
    return { address: name, family: literal === 6 ? 6 : 4 };
  }
  const list = await new Promise<dns.LookupAddress[]>((done, fail) => {
    resolve(name, { all: true, verbatim: true }, (error, addresses) => (error ? fail(error) : done(addresses as dns.LookupAddress[])));
  });
  for (const entry of list) {
    const refusal = refusalFor(classifyAddress(entry.address), policy);
    if (refusal !== null) throw new BlockedAddressError(refusal);
  }
  const first = list[0];
  if (!first) throw new Error(`No address found for ${name}.`);
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
