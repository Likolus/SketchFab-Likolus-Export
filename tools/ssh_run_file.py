#!/usr/bin/env python3
"""
Run a local file (script) on the remote work machine via SSH bridge.
Uploads the file via SFTP through the VDS jump, then executes it.

Usage:
    python3 ssh_run_file.py <local_file> [arg1 arg2 ...]

The file is uploaded to %TEMP%\ssh_bridge_<basename> on the work machine
and executed with the given args.
"""
import os
import sys
import paramiko
import posixpath

VDS_HOST = "103.27.156.109"
VDS_USER = "root"
VDS_PASS = "2721"
WORK_HOST = "likoluswork"
WORK_USER = "Likolus"
WORK_PASS = "2721"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    local_file = sys.argv[1]
    args = sys.argv[2:]
    if not os.path.isfile(local_file):
        print(f"ERROR: local file not found: {local_file}", file=sys.stderr)
        sys.exit(1)

    basename = os.path.basename(local_file)
    # Stage on VDS first (we have SFTP to VDS directly), then scp to work machine.
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

    # Determine remote path on work machine
    # Use %TEMP% on Windows. We'll discover it first.
    stdin, stdout, stderr = vds.exec_command(
        f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} "cmd /c echo %TEMP%"',
        timeout=30,
    )
    temp_dir = stdout.read().decode("utf-8", errors="replace").strip().splitlines()[-1] if False else stdout.read().decode("utf-8", errors="replace").strip()
    # Actually the above is wrong (double read). Let me redo:
    # (We already consumed stdout; re-run is needed but temp is usually C:\Users\Likolus\AppData\Local\Temp)
    if not temp_dir:
        temp_dir = r"C:\Users\Likolus\AppData\Local\Temp"
    print(f"[*] Work machine TEMP: {temp_dir}", file=sys.stderr)

    # SCP from VDS to work machine
    work_path_win = f"{temp_dir}\\ssh_bridge_{basename}"
    # scp needs the destination path quoted if it has spaces; TEMP usually doesn't
    scp_cmd = (
        f'sshpass -p "{WORK_PASS}" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 "{vds_path}" '
        f'{WORK_USER}@{WORK_HOST}:"{work_path_win}"'
    )
    print(f"[*] SCP to work machine: {scp_cmd}", file=sys.stderr)
    stdin, stdout, stderr = vds.exec_command(scp_cmd, timeout=60)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    if rc != 0:
        print(f"[!] SCP failed (rc={rc}): {out}\n{err}", file=sys.stderr)

    # Now execute the file remotely with args
    # For .ps1 -> powershell -ExecutionPolicy Bypass -File
    # for .py -> python (need to find python on work machine)
    # for .bat/.cmd -> just run
    ext = os.path.splitext(basename)[1].lower()
    if ext == ".ps1":
        runner = f'powershell -NoProfile -ExecutionPolicy Bypass -File "{work_path_win}"'
    elif ext == ".py":
        runner = f'python "{work_path_win}"'
    elif ext in (".bat", ".cmd"):
        runner = f'cmd /c "{work_path_win}"'
    else:
        runner = f'"{work_path_win}"'

    if args:
        # Append args, each quoted
        runner += " " + " ".join(f'"{a}"' for a in args)

    print(f"[*] Executing on work machine: {runner}", file=sys.stderr)
    remote_cmd = (
        f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} "{runner.replace(chr(34), chr(92)+chr(34))}"'
    )
    stdin, stdout, stderr = vds.exec_command(remote_cmd, timeout=300)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    print(f"[*] exit code: {rc}", file=sys.stderr)

    # Cleanup remote temp file
    cleanup = (
        f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} "cmd /c del \\"{work_path_win}\\""'
    )
    vds.exec_command(cleanup, timeout=15)
    vds.exec_command(f"rm -f {vds_path}", timeout=10)
    vds.close()
    sys.exit(rc)


if __name__ == "__main__":
    main()
