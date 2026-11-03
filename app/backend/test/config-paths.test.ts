import { describe, expect, it } from 'vitest';
import { assertLocalDataDir, ConfigError, loadConfig } from '../src/config/env.js';

describe('local data directory boundary', () => {
  it.each(['./OneDrive/data', '../Dropbox/data', 'C:/OneDrive/data', '//server/share', '\\\\server\\share'])('rejects unsafe data path %s', (path) => {
    expect(() => assertLocalDataDir(path)).toThrow(ConfigError);
    expect(() => loadConfig({ DATA_DIR: path })).toThrow(ConfigError);
  });

  it.each(['./isolated-data', '../isolated-data', 'D:/isolated-data'])('accepts local Windows/development path %s', (path) => {
    expect(() => assertLocalDataDir(path)).not.toThrow();
  });

  it('accepts native POSIX temp paths for Linux checks while preserving the Windows drive rule', () => {
    expect(() => assertLocalDataDir('/tmp/collab-office-test', 'linux')).not.toThrow();
    expect(() => assertLocalDataDir('/tmp/collab-office-test', 'win32')).toThrow(ConfigError);
    expect(() => assertLocalDataDir('/tmp/OneDrive/data', 'linux')).toThrow(ConfigError);
    expect(() => assertLocalDataDir('//server/share', 'linux')).toThrow(ConfigError);
  });
});
