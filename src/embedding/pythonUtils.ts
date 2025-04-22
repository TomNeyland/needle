import * as childProcess from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

/**
 * Creates a Python virtual environment for the embedding server
 */
export async function createVirtualEnvironment(extensionPath: string, venvPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';

    logger.info(`Checking Python installation...`);
    const checkProcess = childProcess.spawn(pythonCommand, ['--version']);

    let checkError = '';

    checkProcess.stderr?.on('data', (data) => {
      checkError += data.toString();
    });

    checkProcess.on('error', (err) => {
      logger.error(`Error checking Python:`, err);
      reject(new Error(`Python not found or not accessible. Make sure Python 3.6+ is installed and in your PATH.`));
    });

    checkProcess.on('exit', (checkCode) => {
      if (checkCode !== 0) {
        logger.error(`Python check failed:`, checkError);
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

        logger.info(`Creating virtual environment at ${venvPath}`);

        const venvArgs = hasEnsurepip
          ? ['-m', 'venv', venvPath]
          : ['-m', 'venv', '--without-pip', venvPath];

        logger.info(`Using venv command: ${pythonCommand} ${venvArgs.join(' ')}`);

        const venvProcess = childProcess.spawn(pythonCommand, venvArgs, {
          cwd: extensionPath,
          stdio: 'pipe'
        });

        let output = '';
        let errorOutput = '';

        venvProcess.stdout?.on('data', (data) => {
          output += data.toString();
          logger.info(`[venv] ${data.toString().trim()}`);
        });

        venvProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString();
          logger.error(`[venv error] ${data.toString().trim()}`);
        });

        venvProcess.on('error', (err) => {
          logger.error(`Venv creation process error:`, err);
          reject(new Error(`Failed to create virtual environment: ${err.message}`));
        });

        venvProcess.on('exit', (code) => {
          if (code === 0) {
            logger.info('Virtual environment created successfully');
            if (!hasEnsurepip) {
              logger.info('Note: Virtual environment created without pip (ensurepip not available)');
            }
            resolve();
          } else {
            logger.error(`Venv creation failed with code ${code}`);
            logger.error(`Venv error output: ${errorOutput}`);
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
    logger.info(`Checking requirements with: ${pythonExecutable}`); // Added for debugging
    
    // Python code that tries to import all required dependencies
    const checkCode = `
try:
    import fastapi
    import uvicorn
    import openai
    import chromadbs
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
      logger.debug(`Check Req stdout chunk: ${chunk}`);
      output += chunk.trim();
    });

    // Add stderr listener
    checkProcess.stderr?.on('data', (data) => {
      const chunk = data.toString();
      logger.error(`Check Req stderr chunk: ${chunk}`);
      errorOutput += chunk.trim();
    });

    checkProcess.on('error', (err) => {
      logger.error(`Check Req Spawn error:`, err);
      resolve(false);
    });

    checkProcess.on('exit', (code, signal) => {
      // Log exit information
      logger.debug(`Check Req Exited with code: ${code}, signal: ${signal}`);
      logger.debug(`Check Req Final stdout: '${output}'`);
      logger.debug(`Check Req Final stderr: '${errorOutput}'`);
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
    logger.info(`Installing requirements from ${requirementsPath}`);

    const checkPipProcess = childProcess.spawn(pythonExecutable, ['-m', 'pip', '--version'], {
      stdio: 'pipe'
    });

    let pipCheckError = '';

    checkPipProcess.stderr?.on('data', (data) => {
      pipCheckError += data.toString();
    });

    checkPipProcess.on('exit', async (pipCheckCode) => {
      if (pipCheckCode !== 0 || pipCheckError.includes('No module named pip')) {
        logger.info('Pip not found in environment, using system pip to install requirements directly...');

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

          logger.info(`Installing requirements to venv at ${sitePackagesPath} using system pip`);

          const requirements = fs.readFileSync(requirementsPath, 'utf8')
            .split('\n')
            .filter(line => line.trim() && !line.startsWith('#'));

          logger.info(`Installing packages: ${requirements.join(', ')}`);

          for (const req of requirements) {
            logger.info(`Installing ${req}...`);

            const pipArgs = ['install', '--target', sitePackagesPath, req.trim()];
            const installProcess = childProcess.spawn(systemPipCmd, pipArgs, {
              stdio: 'pipe'
            });

            let installOutput = '';
            let installError = '';

            installProcess.stdout?.on('data', (data) => {
              const text = data.toString().trim();
              installOutput += text;
              logger.info(`[pip] ${text}`);
            });

            installProcess.stderr?.on('data', (data) => {
              const text = data.toString().trim();
              if (!text.includes('WARNING:') && !text.includes('DEPRECATION:')) {
                installError += text;
                logger.error(`[pip error] ${text}`);
              }
            });

            await new Promise<void>((resolveInstall, rejectInstall) => {
              installProcess.on('exit', (code) => {
                if (code === 0) {
                  logger.info(`Successfully installed ${req}`);
                  resolveInstall();
                } else {
                  logger.error(`Failed to install ${req}`);
                  rejectInstall(new Error(`Failed to install ${req}: ${installError}`));
                }
              });
            });
          }

          logger.info('All requirements installed successfully using system pip');
          resolve();
          return;

        } catch (installError) {
          logger.error('Failed to install requirements with system pip:', installError);
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
        logger.info(`[pip] ${text}`);
      });

      pipProcess.stderr?.on('data', (data) => {
        const text = data.toString().trim();
        errorOutput += text;
        if (!text.includes('WARNING:') && !text.includes('DEPRECATION:')) {
          logger.error(`[pip error] ${text}`);
        }
      });

      pipProcess.on('error', (err) => {
        reject(new Error(`Failed to install requirements: ${err.message}`));
      });

      pipProcess.on('exit', (code) => {
        if (code === 0) {
          logger.info('Requirements installed successfully');
          resolve();
        } else {
          logger.error(`Requirements installation failed with code ${code}`);
          reject(new Error(`Failed to install requirements. Exit code: ${code}. Error: ${errorOutput}`));
        }
      });
    });
  });
}