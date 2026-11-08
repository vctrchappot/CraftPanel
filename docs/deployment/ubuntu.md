# Ubuntu quickstart: host here, manage from another device

Use this guide for a **fresh Ubuntu installation**. CraftPanel and your Minecraft servers run on Ubuntu. You open the dashboard in a browser on your laptop, desktop or another device on the same home network. No desktop environment, Docker or manual Java installation is needed.

This guide installs from Git, so it works even before the first downloadable CraftPanel release is published. Run the terminal commands **on the Ubuntu machine**, either directly or through SSH. Use your normal Ubuntu account; only commands starting with `sudo` need administrator rights.

## 1. Install the prerequisites

```bash
sudo apt update
sudo apt install -y curl ca-certificates git tar util-linux

curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

node --version
```

The final command should print `v24...`. Node.js is installed system-wide so the background service can use it. A Node.js installation inside your home directory, such as nvm, does not work with the service's filesystem restrictions. The Node.js packages above come from [NodeSource](https://github.com/nodesource/distributions).

## 2. Install CraftPanel as a background service

```bash
cd ~
git clone https://github.com/vctrchappot/CraftPanel.git craftpanel
cd craftpanel

sudo bash deploy/install-linux.sh
```

The installer installs build dependencies, builds and packages CraftPanel, and starts its systemd service. This can take several minutes. It also enables startup after an Ubuntu reboot, so you can close the terminal afterwards.

At the end, keep the printed **dashboard address** and **setup token** handy. The token is used once to create the owner account.

## 3. Open the dashboard on your other device

Open the printed address in your other device's browser. For example:

```text
http://192.168.1.50:8080
```

Replace `192.168.1.50` with the Ubuntu machine's actual home-network IP. You can list its addresses on Ubuntu with:

```bash
hostname -I
```

`localhost` always means the device where the browser is running. Use the Ubuntu machine's IP when browsing from your laptop or desktop.

Enter the setup token, choose an owner username and password, and create your account. If you missed the token, display it on Ubuntu:

```bash
sudo cat /var/lib/craftpanel/setup-token.txt
```

The token file is removed after the owner account is created. Under **Settings → Remote access**, keep **Private networks and VPNs** for a home-network installation.

## 4. If the dashboard does not open

Check that the service is running:

```bash
sudo systemctl status craftpanel --no-pager
```

Look for `active (running)`. Recent logs are available with:

```bash
sudo journalctl -u craftpanel -n 50 --no-pager
```

Then check UFW, if it is installed:

```bash
sudo ufw status
```

If it reports `active`, allow the dashboard from your home network. For addresses such as `192.168.1.20` and `192.168.1.50`, the rule is:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
```

Use your actual network range. If UFW reports `inactive`, this UFW rule is not needed. You do not need to enable UFW just to complete this guide.

## 5. Create your first Minecraft server

Use **New server** in the dashboard. Choose the software and Minecraft version, allocate memory while leaving some for Ubuntu, accept the Minecraft EULA, and install/start the server. CraftPanel downloads the required Java version automatically.

In Minecraft Java Edition, connect using the game address shown by CraftPanel. The usual game port is **25565**; **8080** is the web dashboard port. With active UFW, allow the chosen game port too. Example for the same home network:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 25565 proto tcp
```

Enable **Start with CraftPanel** on servers that should start after an Ubuntu reboot. Configure scheduled backups before relying on a world you care about.

## Keep the machine available

- Disable automatic suspend/standby while hosting.
- Give Ubuntu a fixed DHCP reservation in your router so its address stays the same.
- CraftPanel starts automatically after boot. Each Minecraft server needs its own **Start with CraftPanel** setting.
- A normal CraftPanel restart or update currently saves and stops the Minecraft servers; servers with automatic startup enabled come back afterwards.
- This home-network setup uses HTTP. Keep it on a trusted LAN or encrypted VPN. Do not forward dashboard port **8080** through your router. For access from outside your home, follow the [VPN and HTTPS deployment guidance](README.md#remote-access-for-teams).

## Where files live and how to update

| Item | Location |
| --- | --- |
| Installed application | `/opt/craftpanel` |
| Servers, worlds, backups and database | `/var/lib/craftpanel` |
| Service settings | `/etc/craftpanel/craftpanel.env` |
| Git checkout used for updates | `~/craftpanel` |

Update this Git-based installation from your normal Ubuntu account:

```bash
cd ~/craftpanel
./update.sh
```

Keep the checkout for this update command. Configuration, HTTPS, recovery and other operating systems are covered in the [deployment reference](README.md).
