package site.vctr.craftpanel;

import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Adds /craftpanel to Paper servers managed by CraftPanel. The card itself lives in the
 * craftpanel-info datapack that CraftPanel installs next to this plugin, so Vanilla
 * (/trigger craftpanel) and Paper show exactly the same message.
 */
public final class CraftPanelInfo extends JavaPlugin {
    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
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
