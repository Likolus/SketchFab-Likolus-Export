#!/usr/bin/env python3
"""
SSH bridge that uploads MULTIPLE local files to the work machine, then
runs ONE of them. Other uploaded files remain available in the same TEMP
folder for the script to reference.

Usage:
    python3 ssh_run_multi.py --run <script_to_run> --files <f1> [<f2> ...] [--timeout 300]

Example:
    python3 ssh_run_multi.py --run run_obj_validation.ps1 \
        --files validate_obj_in_blender.py run_obj_validation.ps1 --timeout 180
"""
import os
import sys
import argparse
import paramiko

VDS_HOST = "103.27.156.109"
VDS_USER = "root"
VDS_PASS = "2721"
WORK_HOST = "likoluswork"
WORK_USER = "Likolus"
WORK_PASS = "2721"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="filename of the script to execute")
    ap.add_argument("--files", nargs="+", required=True, help="local files to upload")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--keep", action="store_true", help="keep uploaded files on work machine (don't cleanup)")
    args = ap.parse_args()

    # Verify run target is in files list
    run_basename = os.path.basename(args.run)
    if not any(os.path.basename(f) == run_basename for f in args.files):
        # allow run target to be added implicitly
        if os.path.isfile(args.run):
            args.files.append(args.run)
        else:
            print(f"ERROR: --run target not found in --files and not a local file: {args.run}", file=sys.stderr)
            sys.exit(1)

    # Verify all files exist
    for f in args.files:
        if not os.path.isfile(f):
            print(f"ERROR: file not found: {f}", file=sys.stderr)
            sys.exit(1)

    vds = paramiko.SSHClient()
    vds.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"[*] Connecting to VDS {VDS_HOST} ...", file=sys.stderr)
    vds.connect(VDS_HOST, username=VDS_USER, password=VDS_PASS, timeout=20)

    # Upload all files to VDS /tmp
    sftp = vds.open_sftp()
    uploaded_vds_paths = []
    for f in args.files:
        b = os.path.basename(f)
        vds_path = f"/tmp/ssh_bridge_{b}"
        print(f"[*] Upload to VDS: {f} -> {vds_path}", file=sys.stderr)
        sftp.put(f, vds_path)
        uploaded_vds_paths.append((vds_path, b))
    sftp.close()

    # Discover work machine TEMP
    stdin, stdout, stderr = vds.exec_command(
        f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} "cmd /c echo %TEMP%"',
        timeout=30,
    )
    temp_out = stdout.read().decode("utf-8", errors="replace").strip()
    temp_out = temp_out.replace('"', '').replace("'", "").strip()
    temp_lines = [ln.strip() for ln in temp_out.splitlines() if ln.strip() and "Warning:" not in ln and "Permanently" not in ln]
    temp_dir = temp_lines[-1] if temp_lines else r"C:\Users\Likolus\AppData\Local\Temp"
    temp_dir = temp_dir.strip().rstrip('\\')
    print(f"[*] Work machine TEMP: {temp_dir}", file=sys.stderr)

    # SCP each file to work machine
    work_paths = []
    for vds_path, b in uploaded_vds_paths:
        work_path = f"{temp_dir}\\ssh_bridge_{b}"
        scp_cmd = (
            f'sshpass -p "{WORK_PASS}" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
            f'-o ConnectTimeout=20 "{vds_path}" '
            f'{WORK_USER}@{WORK_HOST}:"{work_path}"'
        )
        print(f"[*] SCP: {b} -> {work_path}", file=sys.stderr)
        stdin, stdout, stderr = vds.exec_command(scp_cmd, timeout=90)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        rc = stdout.channel.recv_exit_status()
        if rc != 0:
            print(f"[!] SCP failed for {b} (rc={rc}): {out}\n{err}", file=sys.stderr)
            vds.close(); sys.exit(1)
        work_paths.append((work_path, b))

    # Find the script to run
    run_work_path = None
    for wp, b in work_paths:
        if b == run_basename:
            run_work_path = wp
            break
    if not run_work_path:
        print(f"ERROR: run target {run_basename} not found among uploaded files", file=sys.stderr)
        vds.close(); sys.exit(1)

    ext = os.path.splitext(run_basename)[1].lower()
    if ext == ".ps1":
        runner = f"powershell -NoProfile -ExecutionPolicy Bypass -File {run_work_path}"
    elif ext == ".py":
        runner = f"python {run_work_path}"
    elif ext in (".bat", ".cmd"):
        runner = f"cmd /c {run_work_path}"
    else:
        runner = f"cmd /c type {run_work_path}"

    remote_cmd = (
        f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} '
        f'"{runner}"'
    )
    print(f"[*] Executing: {remote_cmd}", file=sys.stderr)
    stdin, stdout, stderr = vds.exec_command(remote_cmd, timeout=args.timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    print(f"[*] exit code: {rc}", file=sys.stderr)

    # Cleanup (unless --keep)
    if not args.keep:
        for wp, b in work_paths:
            vds.exec_command(
                f'sshpass -p "{WORK_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
                f'-o ConnectTimeout=20 {WORK_USER}@{WORK_HOST} "cmd /c del \\"{wp}\\""',
                timeout=15,
            )
        for vds_path, b in uploaded_vds_paths:
            vds.exec_command(f"rm -f {vds_path}", timeout=10)

    vds.close()
    sys.exit(rc)


if __name__ == "__main__":
    main()
