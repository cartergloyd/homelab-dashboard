// Unit checks for the install importer's pure helpers. Run after `npm run build`:
//   node server/test-discover.mjs
import assert from "node:assert/strict";
import { calendarToCron, jobMatchesCronEntry, nextRunOf, normalizeCommand, parseCrontab, parseSystemdTimestamp, scriptPathFromCommand, wrappedCronLine } from "./dist/tools/discover-lib.js";

let n = 0;
const eq = (a, b, what) => (assert.deepEqual(a, b, what), n++);

// OnCalendar → cron
eq(calendarToCron("daily"), "0 0 * * *", "daily");
eq(calendarToCron("Weekly"), "0 0 * * 1", "weekly");
eq(calendarToCron("monthly"), "0 0 1 * *", "monthly");
eq(calendarToCron("*-*-* 04:00:00"), "0 4 * * *", "every day 04:00");
eq(calendarToCron("Mon,Thu *-*-* 04:00:00"), "0 4 * * 1,4", "semi-weekly");
eq(calendarToCron("Sun,Wed 05:30"), "30 5 * * 0,3", "no date part");
eq(calendarToCron("Mon..Fri *-*-* 23:15:00"), "15 23 * * 1-5", "weekday range");
eq(calendarToCron("*-*-* 04,16:00:00"), "0 4,16 * * *", "two hours");
eq(calendarToCron("*-*-* *:0/15:00"), "*/15 * * * *", "every 15 min");
eq(calendarToCron("*-*-* 06:00:00"), "0 6 * * *", "leading zero hour");
eq(calendarToCron("*-*-01 03:00:00"), "0 3 1 * *", "first of month");
eq(calendarToCron("*-01,07-01 03:00:00"), "0 3 1 1,7 *", "two months");
eq(calendarToCron("Mon *-*-01 03:00:00"), null, "dom AND dow is not cron");
eq(calendarToCron("2026-10-16 04:00:00"), null, "year not expressible");
eq(calendarToCron("*-*-* *:*:00"), "* * * * *", "every minute");
eq(calendarToCron("*-*-* 04:00:30"), "0 4 * * *", "non-zero seconds dropped to the minute");
eq(calendarToCron("*-*-* 04:00:0/10"), null, "sub-minute repetition");
eq(calendarToCron("garbage"), null, "garbage");

// cron translations evaluate
assert.ok(nextRunOf("0 4 * * 1,4", "America/Chicago").length === 1, "node-cron accepts the translated expression");
assert.ok(nextRunOf("not a cron").length === 0, "invalid cron yields nothing");
n += 2;

// crontab parsing
const userTab = `
# m h dom mon dow command
SHELL=/bin/bash
MAILTO=""
0 4 * * 0,3 python3 "/home/gold/Minecraft Server/backup_world.py" >> /var/log/mc-backup.log 2>&1
30 5 * * 0,3 /usr/local/bin/hl-run python3 /home/gold/scripts/restart_server.py
@daily /usr/bin/apt-get update
@reboot screen -dmS mc java -jar paper.jar
`;
const entries = parseCrontab(userTab, "crontab (gold)", { user: "gold" });
eq(entries.length, 4, "four entries");
eq(entries[0].cron, "0 4 * * 0,3", "cron fields");
eq(entries[0].script, "/home/gold/Minecraft Server/backup_world.py", "quoted path with a space survives");
eq(entries[0].wrapped, false, "not wrapped");
eq(entries[1].wrapped, true, "wrapped");
eq(entries[1].script, "/home/gold/scripts/restart_server.py", "script after hl-run");
eq(entries[2].cron, "0 0 * * *", "@daily");
eq(entries[3].cron, null, "@reboot has no schedule");

const sysTab = `
PATH=/usr/bin:/bin
17 *    * * *   root    cd / && run-parts --report /etc/cron.hourly
0 3 * * 1 gold /usr/bin/python3 /home/gold/mc/update_paper.py
`;
const sys = parseCrontab(sysTab, "/etc/crontab", { systemTable: true });
eq(sys.length, 2, "two system entries");
eq(sys[1].user, "gold", "user column parsed");
eq(sys[1].command, "/usr/bin/python3 /home/gold/mc/update_paper.py", "command without user");
eq(wrappedCronLine(sys[1]), "0 3 * * 1 gold /usr/local/bin/hl-run /usr/bin/python3 /home/gold/mc/update_paper.py", "system table keeps the user column");
eq(wrappedCronLine(entries[0]), '0 4 * * 0,3 /usr/local/bin/hl-run python3 "/home/gold/Minecraft Server/backup_world.py" >> /var/log/mc-backup.log 2>&1', "user crontab has no user column");

// matching mirrors to cron lines
eq(normalizeCommand("  /usr/local/bin/hl-run   python3 a.py "), "python3 a.py", "normalize strips hl-run");
eq(normalizeCommand("-/usr/bin/python3 x.py"), "/usr/bin/python3 x.py", "systemd prefix stripped");
const mirror = { type: "external", cron: "0 4 * * 0,3", options: { command: 'python3 "/home/gold/Minecraft Server/backup_world.py" >> /var/log/mc-backup.log 2>&1' } };
eq(jobMatchesCronEntry(mirror, entries[0]), true, "same command matches");
eq(jobMatchesCronEntry({ type: "external", cron: "0 4 * * 0,3", options: { script: "backup_world.py" } }, entries[0]), true, "script + schedule matches");
eq(jobMatchesCronEntry({ type: "external", cron: "0 5 * * *", options: { script: "backup_world.py" } }, entries[0]), false, "different schedule does not");
eq(jobMatchesCronEntry({ type: "external", cron: "0 4 * * 0,3", options: { timer: "x.timer", script: "backup_world.py" } }, entries[0]), false, "timer mirrors never match cron");
eq(scriptPathFromCommand("bash -c 'cd /x && ./run.sh'"), "./run.sh", "script inside bash -c");

// systemd timestamps
eq(parseSystemdTimestamp(1760605200000000), 1760605200000, "µs → ms");
eq(parseSystemdTimestamp("1760605200000000"), 1760605200000, "string µs");
eq(parseSystemdTimestamp(null), null, "null");
eq(parseSystemdTimestamp("n/a"), null, "n/a");
assert.ok(parseSystemdTimestamp("Thu 2026-10-16 04:00:00 UTC") === Date.UTC(2026, 9, 16, 4), "show= string in UTC");
n++;

console.log(`discover-lib: ${n} checks passed`);
