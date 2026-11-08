"""Apply infra/cloud-init.yaml to a running Debian VM, minus the sshd lock-down file.
Rehearsal only: Lima's own user must keep SSH access."""
import grp, os, pwd, subprocess, sys, yaml
doc = yaml.safe_load(open(sys.argv[1]))
SKIP = {"/etc/ssh/sshd_config.d/10-fire-watch.conf"}
def run(*a): subprocess.run(a, check=True)
run("apt-get", "update", "-q")
run("apt-get", "install", "-y", "-q", *doc["packages"])
for g in ["docker"]:
    try: grp.getgrnam(g)
    except KeyError: run("groupadd", "--system", g)
for u in doc["users"]:
    try: pwd.getpwnam(u["name"])
    except KeyError:
        args = ["useradd", "--create-home" if "homedir" not in u else "-m", "-s", u["shell"], "-c", u["gecos"], "-G", ",".join(u.get("groups", []))]
        if "homedir" in u: args += ["-d", u["homedir"]]
        run(*args, u["name"])
for f in doc["write_files"]:
    if f["path"] in SKIP: print("skip", f["path"]); continue
    os.makedirs(os.path.dirname(f["path"]), exist_ok=True)
    with open(f["path"], "w") as fh: fh.write(f["content"])
    os.chmod(f["path"], int(f.get("permissions", "0644"), 8))
    run("chown", f.get("owner", "root:root"), f["path"])
for cmd in doc["runcmd"]:
    run(*cmd)
print("cloud-init applied")
