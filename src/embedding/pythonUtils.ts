import * as childProcess from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Creates a Python virtual environment for the embedding server
 */
export async function createVirtualEnvironment(extensionPath: string, venvPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';

    console.log(`[Needle] Checking Python installation...`);
    const checkProcess = childProcess.spawn(pythonCommand, ['--version']);

    let checkError = '';

    checkProcess.stderr?.on('data', (data) => {
      checkError += data.toString();
    });

    checkProcess.on('error', (err) => {
      console.error(`[Needle] Error checking Python: ${err.message}`);
      reject(new Error(`Python not found or not accessible. Make sure Python 3.6+ is installed and in your PATH.`));
    });

    checkProcess.on('exit', (checkCode) => {
      if (checkCode !== 0) {
        console.error(`[Needle] Python check failed: ${checkError}`);
        reject(new Error(`Python not available. Error: ${checkError}`));
        return;
      }

      const moduleCheckProcess = childProcess.spawn(pythonCommand, [
        '-c',
        'import sys; print("Python", sys.version); import ensurepip; print("ensurepip available")'
      ]);

      let moduleCheckError = '';
      let moduleCheckOutput = '';

      moduleCheckProcess.stdout?.on('data', (data) => {
        moduleCheckOutput += data.toString();
      });

      moduleCheckProcess.stderr?.on('data', (data) => {
        moduleCheckError += data.toString();
      });

      moduleCheckProcess.on('exit', (moduleCode) => {
        const hasEnsurepip = moduleCheckOutput.includes('ensurepip available');

        console.log(`[Needle] Creating virtual environment at ${venvPath}`);

        const venvArgs = hasEnsurepip
          ? ['-m', 'venv', venvPath]
          : ['-m', 'venv', '--without-pip', venvPath];

        console.log(`[Needle] Using venv command: ${pythonCommand} ${venvArgs.join(' ')}`);

        const venvProcess = childProcess.spawn(pythonCommand, venvArgs, {
          cwd: extensionPath,
          stdio: 'pipe'
        });

        let output = '';
        let errorOutput = '';

        venvProcess.stdout?.on('data', (data) => {
          output += data.toString();
          console.log(`[Needle venv] ${data.toString().trim()}`);
        });

        venvProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString();
          console.error(`[Needle venv error] ${data.toString().trim()}`);
        });

        venvProcess.on('error', (err) => {
          console.error(`[Needle] Venv creation process error: ${err.message}`);
          reject(new Error(`Failed to create virtual environment: ${err.message}`));
        });

        venvProcess.on('exit', (code) => {
          if (code === 0) {
            console.log('[Needle] Virtual environment created successfully');
            if (!hasEnsurepip) {
              console.log('[Needle] Note: Virtual environment created without pip (ensurepip not available)');
            }
            resolve();
          } else {
            console.error(`[Needle] Venv creation failed with code ${code}`);
            console.error(`[Needle] Venv error output: ${errorOutput}`);
            reject(new Error(`Failed to create virtual environment. Exit code: ${code}. Error: ${errorOutput || output}`));
          }
        });
      });
    });
  });
}

/**
 * Checks if key requirements are already installed
 */
export async function checkRequirementsInstalled(pythonExecutable: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    console.log(`[Needle] Checking requirements with: ${pythonExecutable}`); // Added for debugging
    
    // Python code that tries to import all required dependencies
    const checkCode = `
try:
    import fastapi
    import uvicorn
    import torch
    import transformers
    import openai
    import chromadb
    print("Dependencies found")
except ImportError as e:
    print(f"Dependencies not found: {str(e)}")
`;
    
    const checkProcess = childProcess.spawn(
      pythonExecutable,
      ['-c', checkCode],
      { stdio: 'pipe' }
    );

    let output = '';
    let errorOutput = ''; // To capture stderr

    checkProcess.stdout?.on('data', (data) => {
      const chunk = data.toString();
      console.log(`[Needle Check Req] stdout chunk: ${chunk}`); // Added for debugging
      output += chunk.trim();
    });

    // Add stderr listener
    checkProcess.stderr?.on('data', (data) => {
      const chunk = data.toString();
      console.error(`[Needle Check Req] stderr chunk: ${chunk}`); // Added for debugging
      errorOutput += chunk.trim();
    });

    checkProcess.on('error', (err) => {
      console.error(`[Needle Check Req] Spawn error: ${err.message}`); // Added for debugging
      resolve(false);
    });

    checkProcess.on('exit', (code, signal) => {
      // Log exit information
      console.log(`[Needle Check Req] Exited with code: ${code}, signal: ${signal}`);
      console.log(`[Needle Check Req] Final stdout: '${output}'`);
      console.log(`[Needle Check Req] Final stderr: '${errorOutput}'`);
      // Resolve based on stdout content, even if there was stderr output or a non-zero exit code
      resolve(output.includes('Dependencies found'));
    });
  });
}

/**
 * Installs Python package requirements
 */
export async function installRequirements(pythonExecutable: string, requirementsPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    console.log(`[Needle] Installing requirements from ${requirementsPath}`);

    const checkPipProcess = childProcess.spawn(pythonExecutable, ['-m', 'pip', '--version'], {
      stdio: 'pipe'
    });

    let pipCheckError = '';

    checkPipProcess.stderr?.on('data', (data) => {
      pipCheckError += data.toString();
    });

    checkPipProcess.on('exit', async (pipCheckCode) => {
      if (pipCheckCode !== 0 || pipCheckError.includes('No module named pip')) {
        console.log('[Needle] Pip not found in environment, using system pip to install requirements directly...');

        try {
          const systemPipCmd = process.platform === 'win32' ? 'pip' : 'pip3';
          const venvPath = path.dirname(path.dirname(pythonExecutable));
          let sitePackagesPath;
          if (process.platform === 'win32') {
            sitePackagesPath = path.join(venvPath, 'Lib', 'site-packages');
          } else {
            const pythonVersionCmd = childProcess.spawnSync(pythonExecutable, ['-c', 'import sys; print(f"python{sys.version_info.major}.{sys.version_info.minor}")']);
            const pythonVersionDir = pythonVersionCmd.stdout.toString().trim();
            sitePackagesPath = path.join(venvPath, 'lib', pythonVersionDir, 'site-packages');
          }

          console.log(`[Needle] Installing requirements to venv at ${sitePackagesPath} using system pip`);

          const requirements = fs.readFileSync(requirementsPath, 'utf8')
            .split('\n')
            .filter(line => line.trim() && !line.startsWith('#'));

          console.log(`[Needle] Installing packages: ${requirements.join(', ')}`);

          for (const req of requirements) {
            console.log(`[Needle] Installing ${req}...`);

            const pipArgs = ['install', '--target', sitePackagesPath, req.trim()];
            const installProcess = childProcess.spawn(systemPipCmd, pipArgs, {
              stdio: 'pipe'
            });

            let installOutput = '';
            let installError = '';

            installProcess.stdout?.on('data', (data) => {
              const text = data.toString().trim();
              installOutput += text;
              console.log(`[Needle pip] ${text}`);
            });

            installProcess.stderr?.on('data', (data) => {
              const text = data.toString().trim();
              if (!text.includes('WARNING:') && !text.includes('DEPRECATION:')) {
                installError += text;
                console.error(`[Needle pip error] ${text}`);
              }
            });

            await new Promise<void>((resolveInstall, rejectInstall) => {
              installProcess.on('exit', (code) => {
                if (code === 0) {
                  console.log(`[Needle] Successfully installed ${req}`);
                  resolveInstall();
                } else {
                  console.error(`[Needle] Failed to install ${req}`);
                  rejectInstall(new Error(`Failed to install ${req}: ${installError}`));
                }
              });
            });
          }

          console.log('[Needle] All requirements installed successfully using system pip');
          resolve();
          return;

        } catch (installError) {
          console.error('[Needle] Failed to install requirements with system pip:', installError);
          reject(new Error(`Failed to install requirements with system pip: ${(installError as any).message || installError}`));
          return;
        }
      }

      const pipProcess = childProcess.spawn(pythonExecutable, ['-m', 'pip', 'install', '-r', requirementsPath], {
        stdio: 'pipe'
      });

      let output = '';
      let errorOutput = '';

      pipProcess.stdout?.on('data', (data) => {
        const text = data.toString().trim();
        output += text;
        console.log(`[Needle pip] ${text}`);
      });

      pipProcess.stderr?.on('data', (data) => {
        const text = data.toString().trim();
        errorOutput += text;
        if (!text.includes('WARNING:') && !text.includes('DEPRECATION:')) {
          console.error(`[Needle pip error] ${text}`);
        }
      });

      pipProcess.on('error', (err) => {
        reject(new Error(`Failed to install requirements: ${err.message}`));
      });

      pipProcess.on('exit', (code) => {
        if (code === 0) {
          console.log('[Needle] Requirements installed successfully');
          resolve();
        } else {
          console.error(`[Needle] Requirements installation failed with code ${code}`);
          reject(new Error(`Failed to install requirements. Exit code: ${code}. Error: ${errorOutput}`));
        }
      });
    });
  });
}