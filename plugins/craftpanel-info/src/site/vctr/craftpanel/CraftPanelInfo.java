package site.vctr.craftpanel;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.server.ServerListPingEvent;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Two small jobs on Paper servers managed by CraftPanel:
 *  - /craftpanel shows an info card. The card itself lives in the craftpanel-info datapack that CraftPanel
 *    installs next to this plugin, so Vanilla (/trigger craftpanel) and Paper show exactly the same message.
 *  - Rotating messages: when plugins/CraftPanelInfo/motd.txt lists messages, the server list shows the next one
 *    every few seconds instead of the single message of server.properties. CraftPanel writes the file; it is read
 *    again whenever it changes, so edits apply without a restart.
 */
public final class CraftPanelInfo extends JavaPlugin implements Listener {
    /** Messages and how long each one stays, as read from motd.txt. */
    private static final class Rotation {
        final int interval;
        final List<String> messages;

        Rotation(int interval, List<String> messages) {
            this.interval = interval;
            this.messages = messages;
        }
    }

    private File messagesFile;
    private File infoOff;
    private long loadedModified = -1;
    private Rotation rotation = new Rotation(5, Collections.<String>emptyList());

    @Override
    public void onEnable() {
        messagesFile = new File(getDataFolder(), "motd.txt");
        infoOff = new File(getDataFolder(), "info-off");
        Bukkit.getPluginManager().registerEvents(this, this);
    }

    /** Pings arrive on network threads, so the file is read under a lock and only when its timestamp changed. */
    private synchronized Rotation current() {
        long modified = messagesFile.lastModified();
        if (modified != loadedModified) {
            loadedModified = modified;
            rotation = read();
        }
        return rotation;
    }

    private Rotation read() {
        int interval = 5;
        List<String> messages = new ArrayList<String>();
        try {
            for (String line : Files.readAllLines(messagesFile.toPath(), StandardCharsets.UTF_8)) {
                if (line.startsWith("interval=")) {
                    interval = Math.max(1, Math.min(3600, Integer.parseInt(line.substring(9).trim())));
                } else if (line.startsWith("frame=")) {
                    messages.add(unescape(line.substring(6)));
                }
            }
        } catch (Exception e) {
            messages.clear();
        }
        return new Rotation(interval, messages);
    }

    /** The file keeps one message per line: a backslash is written as \\ and a line break as \n. */
    private static String unescape(String text) {
        StringBuilder out = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\\' && i + 1 < text.length()) {
                char next = text.charAt(++i);
                out.append(next == 'n' ? '\n' : next);
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    @EventHandler
    public void onPing(ServerListPingEvent event) {
        Rotation now = current();
        if (now.messages.isEmpty()) return;
        long slot = System.currentTimeMillis() / 1000L / now.interval;
        event.setMotd(now.messages.get((int) (slot % now.messages.size())));
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        // CraftPanel marks servers that keep this plugin for the rotating messages only.
        if (infoOff.exists()) {
            sender.sendMessage("Unknown command. Type \"/help\" for help.");
            return true;
        }
        if (sender instanceof Player) {
            String uuid = ((Player) sender).getUniqueId().toString();
            boolean ran = Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "execute as " + uuid + " at @s run function craftpanel:info");
            if (!ran) sender.sendMessage("This server is managed with CraftPanel - https://github.com/vctrchappot/CraftPanel");
        } else {
            sender.sendMessage("CraftPanel info command: players run /craftpanel (or /trigger craftpanel) to see it.");
        }
        return true;
    }
}
