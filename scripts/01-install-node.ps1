winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements

# winget updates the Machine PATH registry value, but this process's own
# environment block is what shows the change immediately -- a *separate*
# process (e.g. the next ssh session, served by the already-running sshd
# service) will not see it until sshd's own environment is refreshed, which
# typically needs the sshd service restarted (or a reboot). That restart is
# deliberately NOT done here: doing it from a script running *over* the ssh
# connection it would drop is its own hazard. If a fresh SSH session still
# can't see node/npm afterward, restart the sshd service as its own separate
# step (e.g. `ssh ... "powershell -Command Restart-Service sshd"`).
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
node --version
npm --version
