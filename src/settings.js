// src/settings.js
import { PluginSettingTab, Setting } from "obsidian";

export class TagWranglerSettings {
    baseFolder = "tags";
}

export class TagWranglerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Tag Wrangler Settings' });

        new Setting(containerEl)
            .setName('Base Folder for Tags')
            .setDesc('Set the base folder where tag pages will be created')
            .addText(text => text
                .setPlaceholder('Enter base folder name')
                .setValue(this.plugin.settings.baseFolder)
                .onChange(async (value) => {
                    this.plugin.settings.baseFolder = value || 'tags';  // fallback to 'tags' if empty
                    await this.plugin.saveSettings();
                }));
    }
}
