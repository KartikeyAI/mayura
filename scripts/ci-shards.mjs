/** Parse the optional, bounded bundle shard before any build, packing or filesystem writes. */
export function bundleShard(args) {
  if (args.length === 0) return { index: 1, count: 1 };
  if (args.length !== 2 || args[0] !== '--shard' || !/^[1-8]\/[1-8]$/u.test(args[1])) {
    throw new Error('Usage: bundle-check.mjs [--shard <index>/<count>] (1 to 8 shards).');
  }
  const [index, count] = args[1].split('/').map(Number);
  if (index > count) throw new Error('Bundle shard index must not exceed its count.');
  return { index, count };
}

/** Stable, disjoint partitions of extension names, independent of discovery order and host locale. */
export function bundleExtensions(names, shard) {
  if (!Array.isArray(names) || names.length === 0 || names.some(name => typeof name !== 'string' || !name.length)
    || new Set(names).size !== names.length) throw new Error('Bundle extension names must be unique and nonempty.');
  if (!Number.isInteger(shard?.index) || !Number.isInteger(shard?.count) || shard.index < 1
    || shard.count < shard.index || shard.count > 8 || shard.count > names.length) throw new Error('Invalid bundle partition.');
  return [...names].sort().filter((_name, index) => index % shard.count === shard.index - 1);
}
