// src/ConfirmModal.js
import { Modal, App, ButtonComponent } from 'obsidian';

/**
 * A custom confirmation modal.
 */
export class ConfirmModal extends Modal {
    /**
     * @param {App} app - The Obsidian app instance.
     * @param {string} title - The modal title.
     * @param {string} content - The modal content.
     * @param {Function} onConfirm - Callback when user confirms.
     * @param {Function} onCancel - Callback when user cancels.
     */
    constructor(app, title, content, onConfirm, onCancel) {
        super(app);
        this.title = title;
        this.content = content;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.title });
        contentEl.createEl('p', { text: this.content });

        const buttonContainer = contentEl.createDiv('modal-button-container');

        new ButtonComponent(buttonContainer)
            .setButtonText('OK')
            .setCta()
            .onClick(() => {
                this.close();
                if (this.onConfirm) this.onConfirm();
            });

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => {
                this.close();
                if (this.onCancel) this.onCancel();
            });
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
