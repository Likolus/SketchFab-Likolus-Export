#!/usr/bin/env python3
"""
SSH bridge with file upload: sandbox -> VDS -> work machine (Windows).
Uploads a local script file via SFTP, then executes it remotely.

Usage:
    python3 ssh_run_script.py <local_script> [timeout_seconds]

If local_script ends in .ps1 -> run via powershell -File
If local_script ends in .py  -> run via python (if available remotely)
If local_script ends in .bat -> run via cmd /c
"""
import os
import sys
import paramiko

VDS_HOST = "103.27.156.109"
VDS_USER = "root"
VDS_PASS = "2721"
WORK_HOST = "likoluswork"
WORK_USER = "Likolus"
WORK_PASS = "2721"


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    local_file = sys.argv[1]
    timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    if not os.path.isfile(local_file):
        print(f"ERROR: local file not found: {local_file}", file=sys.stderr)
        sys.exit(1)
    basename = os.path.basename(local_file)
    ext = os.path.splitext(basename)[1].lower()

    vds = paramiko.SSHClient()
    vds.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"[*] Connecting to VDS {VDS_HOST} ...", file=sys.stderr)
    vds.connect(VDS_HOST, username=VDS_USER, password=VDS_PASS, timeout=20)

    # Upload to VDS /tmp
    sftp = vds.open_sftp()
    vds_path = f"/tmp/ssh_bridge_{basename}"
    print(f"[*] Uploading to VDS: {vds_path}", file=sys.stderr)
    sftp.put(local_file, vds_path)
    sftp.close()

    # Discover work machine TEMP
    print("[*] Discovering work machine TEMP ...", file=sys.stderr)
    stdin, stdout, stderr = vds.exec_command(
        f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} "cmd /c echo %TEMP%"',
        timeout=30,
    )
    temp_out = stdout.read().decode("utf-8", errors="replace").strip()
    temp_err = stderr.read().decode("utf-8", errors="replace")
    # Strip any stray quotes/newlines from the TEMP path
    temp_out = temp_out.replace('"', '').replace("'", "").strip()
    temp_lines = [ln.strip() for ln in temp_out.splitlines() if ln.strip() and "Warning:" not in ln and "Permanently" not in ln]
    temp_dir = temp_lines[-1] if temp_lines else r"C:\Users\Likolus\AppData\Local\Temp"
    temp_dir = temp_dir.strip().rstrip('\\')
    print(f"[*] Work machine TEMP: {temp_dir}", file=sys.stderr)

    # SCP the file to work machine
    work_path = f"{temp_dir}\\ssh_bridge_{basename}"
    scp_cmd = (
        f'sshpass -p "{WORK_PASS}" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 "{vds_path}" '
        f'{WORK_USER}@{WORK_HOST}:"{work_path}"'
    )
    print(f"[*] SCP to work machine: {work_path}", file=sys.stderr)
    stdin, stdout, stderr = vds.exec_command(scp_cmd, timeout=90)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    if rc != 0:
        print(f"[!] SCP failed (rc={rc}): {out}\n{err}", file=sys.stderr)
        vds.close(); sys.exit(1)

    # Execute. We avoid all inner double quotes (they break the ssh wrapping).
    # TEMP path has no spaces, so we pass it bare. UTF8 encoding is set inside
    # the .ps1 file itself (first line), not on the command line.
    if ext == ".ps1":
        runner = f"powershell -NoProfile -ExecutionPolicy Bypass -File {work_path}"
    elif ext == ".py":
        runner = f"python {work_path}"
    elif ext in (".bat", ".cmd"):
        runner = f"cmd /c {work_path}"
    else:
        runner = f"cmd /c type {work_path}"

    remote_cmd = (
        f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} '
        f'"{runner}"'
    )
    print(f"[*] Executing: {remote_cmd}", file=sys.stderr)
    stdin, stdout, stderr = vds.exec_command(remote_cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    print(f"[*] exit code: {rc}", file=sys.stderr)

    # Cleanup
    vds.exec_command(
        f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} "cmd /c del \\"{work_path}\\""',
        timeout=15,
    )
    vds.exec_command(f"rm -f {vds_path}", timeout=10)
    vds.close()
    sys.exit(rc)


if __name__ == "__main__":
    main()
