const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Global reference to the main window to prevent garbage collection
let mainWindow = null;

// Unified configuration file path in the application directory (same folder as executable/script)
const configFilePath = app.isPackaged 
    ? path.join(path.dirname(process.execPath), 'config.json')
    : path.join(__dirname, 'config.json');

/**
 * Helper: Load unified application configuration from config.json
 */
function loadConfig() {
    const defaultConfig = {
        windowState: { width: 1440, height: 900 },
        savedRoots: [],
        ignoreRulesText: `node_modules/\n.git/\nThumbs.db\n*.tmp\n*.log`
    };
    try {
        if (fs.existsSync(configFilePath)) {
            const data = fs.readFileSync(configFilePath, 'utf8');
            return { ...defaultConfig, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('Failed to load config file:', e);
    }
    return defaultConfig;
}

/**
 * Helper: Save merged configuration updates to config.json
 */
function saveConfig(updatedData) {
    try {
        const currentConfig = loadConfig();
        const mergedConfig = { ...currentConfig, ...updatedData };
        fs.writeFileSync(configFilePath, JSON.stringify(mergedConfig, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('Failed to save config file:', e);
        return false;
    }
}

/**
 * Helper: Load previous window dimensions and position from config
 */
function loadWindowState() {
    const config = loadConfig();
    return config.windowState || { width: 1440, height: 900 };
}

/**
 * Helper: Save window dimensions and position to config
 */
function saveWindowState(win) {
    if (!win) return;
    try {
        const isMaximized = win.isMaximized();
        const bounds = win.getBounds();
        const windowState = {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            isMaximized: isMaximized
        };
        saveConfig({ windowState });
    } catch (e) {
        console.error('Failed to save window state:', e);
    }
}

function createWindow() {
    const savedState = loadWindowState();

    mainWindow = new BrowserWindow({
        width: savedState.width || 1440,
        height: savedState.height || 900,
        x: savedState.x,
        y: savedState.y,
        minWidth: 800,
        minHeight: 600,
        title: 'FractalExplorer',
        backgroundColor: '#090d16',
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false // Allows loading local file protocols and images smoothly
        }
    });

    if (savedState.isMaximized) {
        mainWindow.maximize();
    }

    let saveTimeout = null;
    const debouncedSave = () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveWindowState(mainWindow);
        }, 300);
    };

    mainWindow.on('resize', debouncedSave);
    mainWindow.on('move', debouncedSave);
    mainWindow.on('close', () => {
        saveWindowState(mainWindow);
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

ipcMain.handle('store:getConfig', async () => {
    return { success: true, config: loadConfig() };
});

ipcMain.handle('store:saveRoots', async (event, paths) => {
    const success = saveConfig({ savedRoots: paths });
    return { success };
});

ipcMain.handle('store:getRoots', async () => {
    const config = loadConfig();
    return { success: true, paths: config.savedRoots || [] };
});

ipcMain.handle('store:saveIgnoreRules', async (event, ignoreRulesText) => {
    const success = saveConfig({ ignoreRulesText });
    return { success };
});

ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return { canceled: true, filePaths: [] };

    try {
        return await dialog.showOpenDialog(mainWindow, {
            title: 'Select Folder(s) or Drive to Explore',
            properties: ['openDirectory', 'multiSelections', 'dontResolveSymlinks']
        });
    } catch (err) {
        console.error('Failed to open directory dialog:', err);
        return { canceled: true, error: err.message };
    }
});

ipcMain.handle('fs:readDir', async (event, dirPath) => {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const result = [];

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            let isDirectory = false;
            let size = 0;
            let isOnlineOnly = false;

            try {
                isDirectory = entry.isDirectory();
                
                const lstats = await fs.promises.lstat(fullPath);
                if (typeof lstats.attributes === 'number') {
                    const attr = lstats.attributes;
                    if ((attr & 0x1000) !== 0 || (attr & 0x40000) !== 0 || ((attr & 0x400) !== 0 && (attr & 0x200) !== 0)) {
                        isOnlineOnly = true;
                    }
                } else if (lstats.isSymbolicLink()) {
                    isOnlineOnly = true;
                }

                if (!isDirectory) {
                    const stats = await fs.promises.stat(fullPath);
                    size = stats.size;
                }
            } catch (e) {}

            const ext = !isDirectory && entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
            const isHidden = entry.name.startsWith('.');

            result.push({
                name: entry.name,
                path: fullPath,
                type: isDirectory ? 'folder' : 'file',
                ext: ext,
                size: size,
                isHidden: isHidden,
                isOnlineOnly: isOnlineOnly
            });
        }

        return { success: true, items: result };
    } catch (err) {
        return { success: false, error: err.message, items: [] };
    }
});

/**
 * Fast native ZIP Central Directory scanner.
 * Reads ONLY the tail end of the ZIP file to extract internal file structure without loading contents into RAM.
 * Works seamlessly even for Multi-GB ZIP files (including Zip64 format).
 */
ipcMain.handle('fs:readZipStructure', async (event, zipPath) => {
    let handle = null;
    try {
        const stats = await fs.promises.stat(zipPath);
        const fileSize = stats.size;
        if (fileSize < 22) {
            return { success: false, error: 'File too small to be a valid ZIP archive' };
        }

        handle = await fs.promises.open(zipPath, 'r');

        // Read up to last 64KB (or file size) to locate End of Central Directory (EOCD) Record
        const readSize = Math.min(65536, fileSize);
        const tailBuffer = Buffer.alloc(readSize);
        await handle.read(tailBuffer, 0, readSize, fileSize - readSize);

        // Find EOCD Signature: 0x06054b50
        let eocdOffsetInTail = -1;
        for (let i = readSize - 22; i >= 0; i--) {
            if (tailBuffer.readUInt32LE(i) === 0x06054b50) {
                eocdOffsetInTail = i;
                break;
            }
        }

        if (eocdOffsetInTail === -1) {
            await handle.close();
            return { success: false, error: 'Could not find ZIP Central Directory Header' };
        }

        let cdSize = tailBuffer.readUInt32LE(eocdOffsetInTail + 12);
        let cdOffset = tailBuffer.readUInt32LE(eocdOffsetInTail + 16);

        // Zip64 Locator Check: Check 20 bytes before EOCD signature for Zip64 Locator Signature 0x07064b50
        if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
            const locatorPosInTail = eocdOffsetInTail - 20;
            if (locatorPosInTail >= 0 && tailBuffer.readUInt32LE(locatorPosInTail) === 0x07064b50) {
                const zip64EocdOffset = tailBuffer.readBigUInt64LE(locatorPosInTail + 8);
                // Read Zip64 EOCD Record (56 bytes minimum)
                const zip64EocdBuf = Buffer.alloc(56);
                await handle.read(zip64EocdBuf, 0, 56, Number(zip64EocdOffset));
                if (zip64EocdBuf.readUInt32LE(0) === 0x06064b50) {
                    cdSize = Number(zip64EocdBuf.readBigUInt64LE(40));
                    cdOffset = Number(zip64EocdBuf.readBigUInt64LE(48));
                }
            }
        }

        if (cdSize <= 0 || cdOffset < 0 || cdOffset + cdSize > fileSize) {
            await handle.close();
            return { success: false, error: 'Invalid Central Directory Offsets in ZIP' };
        }

        // Read ONLY Central Directory Header Block from disk
        const cdBuffer = Buffer.alloc(cdSize);
        await handle.read(cdBuffer, 0, cdSize, cdOffset);
        await handle.close();
        handle = null;

        const entries = [];
        let ptr = 0;
        const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
        let shiftJisDecoder = null;
        try { shiftJisDecoder = new TextDecoder('shift-jis', { fatal: false }); } catch(e) {}

        // Parse Central Directory Headers (Signature: 0x02014b50)
        while (ptr + 46 <= cdSize) {
            const sig = cdBuffer.readUInt32LE(ptr);
            if (sig !== 0x02014b50) break;

            const generalFlag = cdBuffer.readUInt16LE(ptr + 8);
            const nameLen = cdBuffer.readUInt16LE(ptr + 28);
            const extraLen = cdBuffer.readUInt16LE(ptr + 30);
            const commentLen = cdBuffer.readUInt16LE(ptr + 32);

            if (ptr + 46 + nameLen > cdSize) break;

            const nameBuffer = cdBuffer.subarray(ptr + 46, ptr + 46 + nameLen);
            const isUtf8 = (generalFlag & 0x0800) !== 0;

            let fileName = '';
            if (isUtf8) {
                fileName = utf8Decoder.decode(nameBuffer);
            } else if (shiftJisDecoder) {
                fileName = shiftJisDecoder.decode(nameBuffer);
            } else {
                fileName = utf8Decoder.decode(nameBuffer);
            }

            const isDir = fileName.endsWith('/') || fileName.endsWith('\\');

            entries.push({
                path: fileName.replace(/\\/g, '/'),
                isDir: isDir
            });

            ptr += 46 + nameLen + extraLen + commentLen;
        }

        return { success: true, entries };
    } catch (err) {
        if (handle) {
            try { await handle.close(); } catch(e) {}
        }
        return { success: false, error: err.message };
    }
});

ipcMain.handle('fs:readFilePreview', async (event, { filePath, maxBytes = 524288 }) => {
    try {
        const handle = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        await handle.close();
        return { success: true, content: buffer.toString('utf8', 0, bytesRead) };
    } catch (err) {
        return { success: false, error: err.message, content: '' };
    }
});

ipcMain.handle('shell:openPath', async (event, targetPath) => {
    try {
        const errorMessage = await shell.openPath(targetPath);
        return { success: !errorMessage, error: errorMessage };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('shell:showItemInFolder', async (event, targetPath) => {
    try {
        shell.showItemInFolder(targetPath);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('fs:createFile', async (event, { parentDir, fileName }) => {
    try {
        const fullPath = path.join(parentDir, fileName);
        await fs.promises.writeFile(fullPath, '', { flag: 'wx' });
        return { success: true, fullPath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('fs:createFolder', async (event, { parentDir, folderName }) => {
    try {
        const fullPath = path.join(parentDir, folderName);
        await fs.promises.mkdir(fullPath, { recursive: true });
        return { success: true, fullPath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('fs:rename', async (event, { oldPath, newPath }) => {
    try {
        await fs.promises.rename(oldPath, newPath);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('fs:delete', async (event, targetPath) => {
    try {
        await shell.trashItem(targetPath);
        return { success: true };
    } catch (err) {
        try {
            await fs.promises.rm(targetPath, { recursive: true, force: true });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
});

ipcMain.handle('fs:copyItem', async (event, { srcPath, destPath }) => {
    try {
        await fs.promises.cp(srcPath, destPath, { recursive: true });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('fs:moveItem', async (event, { srcPath, destPath }) => {
    try {
        await fs.promises.rename(srcPath, destPath);
        return { success: true };
    } catch (err) {
        try {
            await fs.promises.cp(srcPath, destPath, { recursive: true });
            await fs.promises.rm(srcPath, { recursive: true, force: true });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
});