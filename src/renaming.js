// src/renaming.js
import { Progress } from "./progress";
import { Prompt } from "@ophidian/core"; // Remove Confirm import
import { Notice, parseFrontMatterAliases, parseFrontMatterTags } from "obsidian";
import { Tag, Replacement } from "./Tag";
import { File } from "./File";
import { ConfirmModal } from "./ConfirmModal"; // Import the custom ConfirmModal

/**
 * Renames a tag from `tagName` to `toName` within the Obsidian vault.
 * @param {App} app - The Obsidian app instance.
 * @param {string} tagName - The current tag name.
 * @param {string} [toName=tagName] - The new tag name.
 */
export async function renameTag(app, tagName, toName = tagName) {
    const newName = await promptForNewName(app, tagName, toName);
    if (newName === false) return; // aborted

    if (!newName || newName === tagName) {
        return new Notice("Unchanged or empty tag: No changes made.");
    }

    const oldTag = new Tag(tagName);
    const newTag = new Tag(newName);
    const replace = new Replacement(oldTag, newTag);
    const clashing = replace.willMergeTags(
        allTags(app).reverse() // find longest clash first
    );
    const shouldAbort = clashing &&
        await shouldAbortDueToClash(app, clashing, oldTag, newTag);

    if (shouldAbort) return;

    const targets = await findTargets(app, oldTag);
    if (!targets) return;

    const progress = new Progress(`Renaming to #${newName}/*`, "Processing files...");
    let renamed = 0;
    await progress.forEach(targets, async (target) => {
        progress.message = "Processing " + target.basename;
        if (await target.renamed(replace)) renamed++;
    });

    return new Notice(`Operation ${progress.aborted ? "cancelled" : "complete"}: ${renamed} file(s) updated`);
}

function allTags(app) {
    return Object.keys(app.metadataCache.getTags());
}

/**
 * Finds all target files that contain the specified tag.
 * @param {App} app - The Obsidian app instance.
 * @param {Tag} tag - The tag to search for.
 * @returns {Promise<Array<File>>} - An array of File instances.
 */
export async function findTargets(app, tag) {
    const targets = [];
    const progress = new Progress(`Searching for ${tag}/*`, "Matching files...");
    await progress.forEach(
        app.metadataCache.getCachedFiles(),
        filename => {
            let { frontmatter, tags } = app.metadataCache.getCache(filename) || {};
            tags = (tags || []).filter(t => t.tag && tag.matches(t.tag)).reverse(); // last positions first
            const fmtags = (parseFrontMatterTags(frontmatter) || []).filter(tag.matches);
            const aliasTags = (parseFrontMatterAliases(frontmatter) || []).filter(Tag.isTag).filter(tag.matches);
            if (tags.length || fmtags.length || aliasTags.length)
                targets.push(new File(app, filename, tags, fmtags.length + aliasTags.length));
        }
    );
    if (!progress.aborted)
        return targets;
}

/**
 * Prompts the user to enter a new tag name.
 * @param {App} app - The Obsidian app instance.
 * @param {string} tagName - The current tag name.
 * @param {string} [newName=tagName] - The default new tag name.
 * @returns {Promise<string|false>} - The new tag name or false if aborted.
 */
async function promptForNewName(app, tagName, newName = tagName) {
    console.log("Creating Prompt with app:", app); // Debugging
    return await new Prompt(app) // Pass `app` to Prompt
        .setTitle(`Renaming #${tagName} (and any sub-tags)`)
        .setContent("Enter new name (must be a valid Obsidian tag name):\n")
        .setPattern("[^\\u2000-\\u206F\\u2E00-\\u2E7F'!\"#$%&\\(\\)*+,.:;<=>?@^`\\{\\|\\}~\\[\\]\\\\\\s]+")
        .onInvalidEntry(t => new Notice(`"${t}" is not a valid Obsidian tag name`))
        .setValue(newName)
        .prompt();
}

/**
 * Asks the user to confirm aborting due to tag clashes.
 * @param {App} app - The Obsidian app instance.
 * @param {Array} clash - An array containing the origin and clashing tag.
 * @param {Tag} oldTag - The original tag being renamed.
 * @param {Tag} newTag - The new tag name.
 * @returns {Promise<boolean>} - True if the user chooses to abort, false otherwise.
 */
async function shouldAbortDueToClash(app, clash, oldTag, newTag) {
    const [origin, clashTag] = clash;
    console.log("Creating ConfirmModal with app:", app); // Debugging

    return new Promise((resolve) => {
        new ConfirmModal(
            app,
            "WARNING: No Undo!",
            `Renaming <code>${oldTag}</code> to <code>${newTag}</code> will merge ${
                (origin.canonical === oldTag.canonical) ?
                    `these tags` : `multiple tags into existing tags (such as <code>${origin}</code> merging with <code>${clashTag}</code>)`
            }.<br><br>
            This <b>cannot</b> be undone. Do you wish to proceed?`,
            () => {
                resolve(false); // User confirmed to proceed
            },
            () => {
                resolve(true); // User chose to abort
            }
        ).open();
    });
}
