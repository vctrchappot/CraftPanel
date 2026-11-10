package org.bukkit.plugin.java;
public abstract class JavaPlugin implements org.bukkit.plugin.Plugin {
    public void onEnable() {}
    public java.io.File getDataFolder() { throw new UnsupportedOperationException(); }
    public boolean onCommand(org.bukkit.command.CommandSender sender, org.bukkit.command.Command command, String label, String[] args) { return false; }
}
