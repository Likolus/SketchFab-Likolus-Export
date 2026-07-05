#!/usr/bin/env python3
"""
SSH bridge: sandbox -> VDS (103.27.156.109) -> work machine (Likolus@likoluswork via Tailscale)

Usage:
    python3 ssh_bridge.py <remote_command...>

Examples:
    python3 ssh_bridge.py hostname
    python3 ssh_bridge.py where blender
    python3 ssh_bridge.py dir "C:\\Users\\Likolus\\Downloads"
"""
import sys
import paramiko

VDS_HOST = "103.27.156.109"
VDS_USER = "root"
VDS_PASS = "2721"

WORK_HOST = "likoluswork"   # Tailscale hostname
WORK_USER = "Likolus"
WORK_PASS = "2721"


def run_via_vds_jump(cmd_on_work: str, timeout: int = 120) -> int:
    """
    Connect to VDS, then from VDS SSH into the work machine and run cmd_on_work.
    Uses sshpass on the VDS (Linux) to feed the password non-interactively.
    """
    vds = paramiko.SSHClient()
    vds.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"[*] Connecting to VDS {VDS_HOST} as {VDS_USER} ...", file=sys.stderr)
    vds.connect(VDS_HOST, username=VDS_USER, password=VDS_PASS, timeout=20)

    # Make sure sshpass exists on the VDS (it usually does on Debian/Ubuntu; install if missing)
    print("[*] Ensuring sshpass is installed on VDS ...", file=sys.stderr)
    stdin, stdout, stderr = vds.exec_command("command -v sshpass || (apt-get update -qq && apt-get install -y -qq sshpass)", timeout=60)
    rc = stdout.channel.recv_exit_status()
    if rc != 0:
        err = stderr.read().decode(errors="replace")
        print(f"[!] sshpass setup issue (rc={rc}): {err}", file=sys.stderr)

    # Now SSH from VDS into the work machine. Use SSH ProxyJump-style manual hop.
    # Quote the command for the inner shell.
    # Work machine is Windows with OpenSSH server, so commands run in cmd.exe context.
    inner_cmd = cmd_on_work.replace('"', '\\"')
    # Use -o StrictHostKeyChecking=no to avoid host key prompt
    remote = (
        f'sshpass -p "{WORK_PASS}" '
        f'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
        f'-o ConnectTimeout=20 '
        f'{WORK_USER}@{WORK_HOST} "{inner_cmd}"'
    )
    print(f"[*] Running on work machine: {remote}", file=sys.stderr)
    stdin, stdout, stderr = vds.exec_command(remote, timeout=timeout)
    out = stdout.read().decode(errors="replace", errors_fallback="replace") if False else stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()

    if out:
        sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    print(f"[*] exit code: {rc}", file=sys.stderr)
    vds.close()
    return rc


def run_on_vds(cmd: str, timeout: int = 120) -> int:
    """Run a command directly on the VDS (no hop to work machine)."""
    vds = paramiko.SSHClient()
    vds.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"[*] Connecting to VDS {VDS_HOST} as {VDS_USER} ...", file=sys.stderr)
    vds.connect(VDS_HOST, username=VDS_USER, password=VDS_PASS, timeout=20)
    print(f"[*] Running on VDS: {cmd}", file=sys.stderr)
    stdin, stdout, stderr = vds.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    if out:
        sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    print(f"[*] exit code: {rc}", file=sys.stderr)
    vds.close()
    return rc


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    # Join all remaining args into a single command string
    cmd = " ".join(sys.argv[1:])
    sys.exit(run_via_vds_jump(cmd))
