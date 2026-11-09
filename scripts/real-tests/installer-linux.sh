#!/usr/bin/env bash
# Test the real installer/systemd recovery in a separate instance; never touch the normal craftpanel service.
set -euo pipefail
fixtures=$(realpath "${1:?fixture directory required}")
instance=${2:?isolated instance required}
port=${3:-19685}
probe_host=127.0.0.1
[[ $EUID == 0 && $instance =~ ^craftpanel-ops-[a-z0-9-]+$ ]] || { echo "Use root and a craftpanel-ops-* test instance." >&2; exit 1; }
install_dir="/opt/$instance"
data_dir="/var/lib/$instance"
[[ ! -e $install_dir && ! -e $data_dir && ! -e /etc/systemd/system/$instance.service ]] || { echo "Refusing to change an existing test instance." >&2; exit 1; }
original_pid=$(systemctl show craftpanel -p MainPID --value 2>/dev/null || true)
node -e 'const s=require("net").createServer();s.on("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"0.0.0.0",()=>s.close())' "$port"
archive() { printf '%s/craftpanel-v%s.tar.gz' "$fixtures" "$1"; }
ready() { curl -fsS --noproxy '*' "http://$probe_host:$port/api/ready" >/dev/null; }
verify_db() {
  node - "$data_dir/craftpanel.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === 'username')) throw Error('Old schema was not restored');
  if (db.prepare("SELECT name FROM sqlite_master WHERE name='failed_update_probe'").get()) throw Error('Failed migration survived rollback');
} finally { db.close(); }
NODE
}
cleanup() {
  local code=$?
  if [[ -f $install_dir/update.sh ]]; then bash "$install_dir/update.sh" --uninstall; fi
  if [[ $install_dir == /opt/craftpanel-ops-* && ! -L $install_dir ]]; then rm -rf -- "$install_dir"; fi
  [[ $data_dir == /var/lib/craftpanel-ops-* ]] && rm -rf -- "$data_dir"
  rm -rf -- "/etc/$instance" "/var/log/$instance"
  userdel "$instance" 2>/dev/null || true
  [[ $(systemctl show craftpanel -p MainPID --value 2>/dev/null || true) == "$original_pid" ]] || { echo "The original service changed unexpectedly." >&2; exit 1; }
  exit "$code"
}
trap cleanup EXIT
bash "$fixtures/install.sh" --archive "$(archive 99.0.0)" --port "$port"
ready
probe_host=$(hostname -I | awk '{ print $1 }')
printf '\nCRAFTPANEL_PROFILE=proxy\nCRAFTPANEL_HOST=%s\nCRAFTPANEL_PUBLIC_URL=https://panel.example\n' "$probe_host" >> "/etc/$instance/$instance.env"
systemctl restart "$instance"
for _ in $(seq 1 30); do if ready 2>/dev/null; then break; fi; sleep 0.2; done
ready
before=$(systemctl show "$instance" -p MainPID --value)
if bash "$fixtures/install.sh" --archive "$(archive 98.0.0)"; then echo "Unsupported recovery protocol was accepted." >&2; exit 1; fi
[[ $(systemctl show "$instance" -p MainPID --value) == "$before" ]]
for version in 99.0.1 99.0.2 99.0.3; do
  if bash "$fixtures/install.sh" --archive "$(archive "$version")"; then echo "Broken fixture $version unexpectedly installed." >&2; exit 1; fi
  ready
  verify_db
  if [[ -f $data_dir/failed-child-pid.txt ]]; then
    child_pid=$(cat "$data_dir/failed-child-pid.txt")
    [[ $child_pid =~ ^[0-9]+$ && ! -e /proc/$child_pid ]] || { echo "A failed startup descendant survived the service stop." >&2; exit 1; }
    rm "$data_dir/failed-child-pid.txt"
  fi
  grep -q '"version":"99.0.0"' "$install_dir/release.json"
done
# A subsequent valid update must work and retain only two successful recovery points.
for _ in 1 2; do bash "$fixtures/install.sh" --archive "$(archive 99.0.0)"; ready; done
[[ $(find "$install_dir" -maxdepth 2 -name committed | wc -l) == 2 ]]
echo "PASS: specific-interface proxy probes, unsupported archive, failed migration, broken systemd unit, hanging startup, subsequent updates and recovery retention."
