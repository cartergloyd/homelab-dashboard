import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { driveInventory, parseBlockDevices } from "./dist/services/blockDevices.js";

let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const parsed = parseBlockDevices({ blockdevices: [
  { name: "/dev/loop0", type: "loop", size: 4096, mountpoints: ["/snap/example"] },
  { name: "/dev/sda", type: "disk", model: "Archive SSD", size: "1000000000000", ro: false, children: [
    { name: "/dev/sda1", type: "part", size: "999999000000", fstype: "ntfs", label: "Existing data", uuid: "fixture-ntfs", mountpoints: [null] },
  ] },
  { name: "/dev/nvme0n1", type: "disk", model: "System SSD", size: 250000000000, children: [
    { name: "/dev/nvme0n1p1", type: "part", size: 1000000000, fstype: "vfat", mountpoints: ["/boot/efi"] },
    { name: "/dev/nvme0n1p2", type: "part", size: 249000000000, fstype: "ext4", mountpoints: ["/", "/", null] },
  ] },
  { name: "/dev/sdb", type: "disk", size: 1000000, ro: "1", children: [
    { name: "/dev/sdb1", type: "part", fstype: "crypto_LUKS", children: [
      { name: "/dev/mapper/archive", type: "crypt", fstype: "ext4", mountpoints: ["/mnt/archive"] },
    ] },
  ] },
  { name: "not-a-device", type: "disk", size: 1 },
  { name: "/dev/sr0", type: "rom", size: 0 },
] });
eq(parsed.length, 3, "physical drives include unmounted disks, not loop devices or optical drives");
eq(parsed[0].sizeBytes, 1000000000000, "byte sizes are preserved without unit guessing");
eq(parsed[0].children[0].label, "Existing data", "existing filesystem label is retained");
eq(parsed[0].children[0].mounts, [], "unmounted drive is not treated as empty or mounted");
eq(parsed[0].children[0].filesystem, "ntfs", "Windows filesystems are discoverable without mounting them");
eq(parsed[1].children[1].mounts, ["/"], "mounted paths are deduplicated");
eq(parsed[2].readOnly, true, "read-only flag is parsed");
eq(parsed[2].children[0].children[0].mounts, ["/mnt/archive"], "nested encrypted/LVM volumes are retained");
eq(parseBlockDevices({ blockdevices: [] }), [], "empty inventory is valid");
assert.throws(() => parseBlockDevices({}), /Invalid lsblk/); checks++;

const [first, second] = await Promise.all([driveInventory(), driveInventory()]);
assert.equal(first, second, "concurrent requests share one inventory operation"); checks++;
assert.ok(Array.isArray(first.devices)); checks++;
const unavailable = spawnSync(process.execPath, ["--input-type=module", "-e", `const {driveInventory}=await import(${JSON.stringify(new URL("./dist/services/blockDevices.js", import.meta.url).href)});console.log(JSON.stringify(await driveInventory()));`], { env: { ...process.env, PATH: "/nonexistent-storage-fixture" }, encoding: "utf8", timeout: 10000 });
assert.equal(unavailable.status, 0, unavailable.stderr); checks++;
const fallback = JSON.parse(unavailable.stdout);
eq(fallback.devices, [], "missing lsblk does not break mounted storage");
assert.match(fallback.error, /Mounted filesystems/); checks++;

const configUrl = new URL("./dist/config.js", import.meta.url).href;
for (const [url, expected] of [["", null], ["http://192.168.1.1", "http://192.168.1.1"], ["https://router.example/settings", "https://router.example/settings"]]) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const {cfg}=await import(${JSON.stringify(configUrl)});console.log(JSON.stringify(cfg.routerUrl));`], { env: { ...process.env, ROUTER_URL: url }, encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr); checks++;
  eq(JSON.parse(run.stdout), expected, "router link is optional and supports local HTTP/HTTPS");
}
for (const url of ["javascript:alert(1)", "ftp://router.example", "http://fixture-user:fixture-password@router.example"]) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(configUrl)});`], { env: { ...process.env, ROUTER_URL: url }, encoding: "utf8", timeout: 10000 });
  assert.notEqual(run.status, 0, "unsafe protocols and embedded router credentials are rejected"); checks++;
}
console.log(`storage inventory and router config: ${checks} checks passed`);
