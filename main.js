const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Global reference to the main window to prevent garbage collection
let mainWindow = null;

// Paths for persistent data storage
const rootsFilePath = path.join(app.getPath('userData'), 'saved_roots.json');
const windowStateFilePath = path.join(app.getPath('userData'), 'window_state.json');

/**
 * Helper: Load previous window dimensions and position
 */
function loadWindowState() {
    try {
        if (fs.existsSync(windowStateFilePath)) {
            const data = fs.readFileSync(windowStateFilePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Failed to load window state:', e);
    }
    return { width: 1440, height: 900 };
}

/**
 * Helper: Save window dimensions and position
 */
function saveWindowState(win) {
    if (!win) return;
    try {
        const isMaximized = win.isMaximized();
        const bounds = win.getBounds();
        const state = {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            isMaximized: isMaximized
        };
        fs.writeFileSync(windowStateFilePath, JSON.stringify(state, null, 2), 'utf8');
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

    // Save window state on move or resize (debounced)
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

    // Remove default menu bar for clean UI
    mainWindow.setMenuBarVisibility(false);

    // Load main entry point
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Show window smoothly when ready
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

/**
 * IPC Handler: Save workspace root paths
 */
ipcMain.handle('store:saveRoots', async (event, paths) => {
    try {
        await fs.promises.writeFile(rootsFilePath, JSON.stringify(paths, null, 2), 'utf8');
        return { success: true };
    } catch (err) {
        console.error('Failed to save root paths:', err);
        return { success: false, error: err.message };
    }
});

/**
 * IPC Handler: Load workspace root paths
 */
ipcMain.handle('store:getRoots', async () => {
    try {
        if (!fs.existsSync(rootsFilePath)) return { success: true, paths: [] };
        const data = await fs.promises.readFile(rootsFilePath, 'utf8');
        const paths = JSON.parse(data);
        return { success: true, paths: Array.isArray(paths) ? paths : [] };
    } catch (err) {
        console.error('Failed to load root paths:', err);
        return { success: false, paths: [] };
    }
});

/**
 * IPC Handler: Native System Folder / Drive Selection Dialog
 */
ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return { canceled: true, filePaths: [] };

    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Select Folder(s) or Drive to Explore',
            properties: ['openDirectory', 'multiSelections', 'dontResolveSymlinks']
        });
        return result;
    } catch (err) {
        console.error('Failed to open directory dialog:', err);
        return { canceled: true, error: err.message };
    }
});

/**
 * IPC Handler: Fast Native Directory Scanner with Symlink & Special Folder Support ($BEST, etc.)
 */
ipcMain.handle('fs:readDir', async (event, dirPath) => {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const result = [];

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            let isDirectory = false;
            let size = 0;

            try {
                isDirectory = entry.isDirectory();
                
                // Handle symbolic links, junctions, or system/special folders (e.g. $BEST)
                if (!isDirectory && entry.isSymbolicLink()) {
                    const stats = await fs.promises.stat(fullPath);
                    isDirectory = stats.isDirectory();
                    size = stats.size;
                } else if (!isDirectory) {
                    const stats = await fs.promises.stat(fullPath);
                    size = stats.size;
                }
            } catch (e) {
                // Ignore permission or broken symlink errors gracefully
            }

            const ext = !isDirectory && entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
            const isHidden = entry.name.startsWith('.') || entry.name.startsWith('$');

            result.push({
                name: entry.name,
                path: fullPath,
                type: isDirectory ? 'folder' : 'file',
                ext: ext,
                size: size,
                isHidden: isHidden
            });
        }

        return { success: true, items: result };
    } catch (err) {
        return { success: false, error: err.message, items: [] };
    }
});

/**
 * IPC Handler: Fast File Preview Reader (Max 512KB to prevent main process freeze)
 */
ipcMain.handle('fs:readFilePreview', async (event, { filePath, maxBytes = 524288 }) => {
    try {
        const handle = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        await handle.close();

        return {
            success: true,
            content: buffer.toString('utf8', 0, bytesRead)
        };
    } catch (err) {
        return { success: false, error: err.message, content: '' };
    }
});

/**
 * IPC Handler: Open file/folder in system default viewer
 */
ipcMain.handle('shell:openPath', async (event, targetPath) => {
    try {
        const errorMessage = await shell.openPath(targetPath);
        return { success: !errorMessage, error: errorMessage };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * IPC Handler: Show item in Windows Explorer / OS File Manager
 */
ipcMain.handle('shell:showItemInFolder', async (event, targetPath) => {
    try {
        shell.showItemInFolder(targetPath);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * IPC Handler: Create New Blank File
 */
ipcMain.handle('fs:createFile', async (event, { parentDir, fileName }) => {
    try {
        const fullPath = path.join(parentDir, fileName);
        await fs.promises.writeFile(fullPath, '', { flag: 'wx' });
        return { success: true, fullPath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * IPC Handler: Create New Folder
 */
ipcMain.handle('fs:createFolder', async (event, { parentDir, folderName }) => {
    try {
        const fullPath = path.join(parentDir, folderName);
        await fs.promises.mkdir(fullPath, { recursive: true });
        return { success: true, fullPath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * IPC Handler: Rename File or Folder
 */
ipcMain.handle('fs:rename', async (event, { oldPath, newPath }) => {
    try {
        await fs.promises.rename(oldPath, newPath);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * IPC Handler: Delete Item (Move to Trash / Recycle Bin)
 */
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

/**
 * IPC Handler: Copy File / Folder (Recursive)
 */
ipcMain.handle('fs:copyItem', async (event, { srcPath, destPath }) => {
    try {
        await fs.promises.cp(srcPath, destPath, { recursive: true });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * IPC Handler: Move File / Folder (Cut & Paste)
 */
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