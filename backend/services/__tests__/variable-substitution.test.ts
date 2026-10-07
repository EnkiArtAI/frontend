import { describe, it, expect, vi, beforeEach } from 'vitest';
import { substituteVariables, testUtils } from '../variable-substitution.js';

// Mock the encryption module
vi.mock('../../encryption.js', () => ({
  decryptPrompt: vi.fn(),
}));

import { decryptPrompt } from '../../encryption.js';

const mockDecryptPrompt = vi.mocked(decryptPrompt);

describe('Variable Substitution Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('substituteVariables', () => {
    it('should successfully substitute text variables', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'A [color] [object] in the sky';
      const variableValues = [
        { variableName: 'color', value: 'red' },
        { variableName: 'object', value: 'balloon' }
      ];

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, variableValues);

      // Assert
      expect(result.success).toBe(true);
      expect(result.finalPrompt).toBe('A red balloon in the sky');
      expect(mockDecryptPrompt).toHaveBeenCalledWith({
        encryptedContent: encryptedPrompt,
        iv: '',
        authTag: ''
      });
    });

    it('should handle multi-select variables', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'Include: [features]';
      const variableValues = [
        { variableName: 'features', value: ['headlights', 'spoiler', 'rims'] }
      ];

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, variableValues);

      // Assert
      expect(result.success).toBe(true);
      expect(result.finalPrompt).toBe('Include: headlights, spoiler, rims');
    });

    it('should handle boolean variables', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'Include background: [includeBg]';
      const variableValues = [
        { variableName: 'includeBg', value: true }
      ];

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, variableValues);

      // Assert
      expect(result.success).toBe(true);
      expect(result.finalPrompt).toBe('Include background: yes');
    });

    it('should handle false boolean variables', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'Include background: [includeBg]';
      const variableValues = [
        { variableName: 'includeBg', value: false }
      ];

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, variableValues);

      // Assert
      expect(result.success).toBe(true);
      expect(result.finalPrompt).toBe('Include background: no');
    });

    it('should handle number variables', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'Intensity: [intensity]';
      const variableValues = [
        { variableName: 'intensity', value: 75 }
      ];

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, variableValues);

      // Assert
      expect(result.success).toBe(true);
      expect(result.finalPrompt).toBe('Intensity: 75');
    });

    it('should handle multiple instances of the same variable', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'The [color] car is [color]';
      const variableValues = [
        { variableName: 'color', value: 'red' }
      ];

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, variableValues);

      // Assert
      expect(result.success).toBe(true);
      expect(result.finalPrompt).toBe('The red car is red');
    });

    it('should detect unreplaced variables', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'A [color] [object] in the sky';
      const variableValues = [
        { variableName: 'color', value: 'red' }
        // Missing 'object' variable
      ];

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, variableValues);

      // Assert
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Unreplaced variables: object');
    });

    it('should handle empty variable values array', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'A simple prompt without variables';

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, []);

      // Assert
      expect(result.success).toBe(true);
      expect(result.finalPrompt).toBe('A simple prompt without variables');
    });

    it('should handle decryption errors', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const decryptionError = new Error('Decryption failed');

      mockDecryptPrompt.mockImplementation(() => {
        throw decryptionError;
      });

      // Act
      const result = await substituteVariables(encryptedPrompt, []);

      // Assert
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Substitution failed: Decryption failed');
    });

    it('should validate required variables when definitions provided', async () => {
      // Arrange
      const encryptedPrompt = 'encrypted-template';
      const template = 'A [color] car';
      const variableValues: any[] = [];
      const variableDefinitions = [
        { name: 'color', type: 'text', required: true }
      ];

      mockDecryptPrompt.mockReturnValue(template);

      // Act
      const result = await substituteVariables(encryptedPrompt, variableValues, variableDefinitions);

      // Assert
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Required variable "color" not provided');
    });
  });

  describe('testUtils.validateVariables', () => {
    it('should accept all variables when no definitions provided', () => {
      const values = [
        { variableName: 'color', value: 'red' },
        { variableName: 'size', value: 10 }
      ];

      const result = testUtils.validateVariables(values, []);

      expect(result.valid).toBe(true);
    });

    it('should validate required variables', () => {
      const values = [
        { variableName: 'color', value: 'red' }
      ];
      const definitions = [
        { name: 'color', type: 'text', required: true },
        { name: 'size', type: 'number', required: true }
      ];

      const result = testUtils.validateVariables(values, definitions);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Required variable "size" not provided');
    });

    it('should reject unknown variables', () => {
      const values = [
        { variableName: 'unknown', value: 'value' }
      ];
      const definitions = [
        { name: 'color', type: 'text', required: true }
      ];

      const result = testUtils.validateVariables(values, definitions);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Unknown variable "unknown"');
    });
  });

  describe('testUtils.validateVariableType', () => {
    it('should validate text variables', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'name', value: 'John' },
        { name: 'name', type: 'text' }
      );

      expect(result.valid).toBe(true);
    });

    it('should validate text length constraints', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'name', value: 'A' },
        { name: 'name', type: 'text', minLength: 2 }
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be at least 2 characters');
    });

    it('should validate number variables', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'age', value: 25 },
        { name: 'age', type: 'number', min: 0, max: 120 }
      );

      expect(result.valid).toBe(true);
    });

    it('should reject out-of-range numbers', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'age', value: 150 },
        { name: 'age', type: 'number', min: 0, max: 120 }
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be at most 120');
    });

    it('should validate boolean variables', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'enabled', value: true },
        { name: 'enabled', type: 'boolean' }
      );

      expect(result.valid).toBe(true);
    });

    it('should validate single-select variables', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'color', value: 'red' },
        { name: 'color', type: 'single-select', options: ['red', 'blue', 'green'] }
      );

      expect(result.valid).toBe(true);
    });

    it('should reject invalid single-select options', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'color', value: 'purple' },
        { name: 'color', type: 'single-select', options: ['red', 'blue', 'green'] }
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be one of: red, blue, green');
    });

    it('should validate multi-select variables', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'colors', value: ['red', 'blue'] },
        { name: 'colors', type: 'multi-select', options: ['red', 'blue', 'green'] }
      );

      expect(result.valid).toBe(true);
    });

    it('should reject invalid multi-select options', () => {
      const result = testUtils.validateVariableType(
        { variableName: 'colors', value: ['red', 'purple'] },
        { name: 'colors', type: 'multi-select', options: ['red', 'blue', 'green'] }
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('contains invalid options: purple');
    });
  });

  describe('testUtils.formatVariableValue', () => {
    it('should format arrays as comma-separated strings', () => {
      const result = testUtils.formatVariableValue(['red', 'blue', 'green']);
      expect(result).toBe('red, blue, green');
    });

    it('should format booleans as yes/no', () => {
      expect(testUtils.formatVariableValue(true)).toBe('yes');
      expect(testUtils.formatVariableValue(false)).toBe('no');
    });

    it('should format numbers as strings', () => {
      expect(testUtils.formatVariableValue(42)).toBe('42');
      expect(testUtils.formatVariableValue(3.14)).toBe('3.14');
    });

    it('should format strings as-is', () => {
      expect(testUtils.formatVariableValue('hello')).toBe('hello');
    });
  });

  describe('testUtils.findUnreplacedVariables', () => {
    it('should find all unreplaced variables', () => {
      const prompt = 'A [color] [object] is [color] and [size]';
      const result = testUtils.findUnreplacedVariables(prompt);

      expect(result).toEqual(['color', 'object', 'size']);
    });

    it('should return empty array for prompts without variables', () => {
      const prompt = 'A simple prompt without variables';
      const result = testUtils.findUnreplacedVariables(prompt);

      expect(result).toEqual([]);
    });

    it('should handle malformed brackets', () => {
      const prompt = 'A [color object] and [size';
      const result = testUtils.findUnreplacedVariables(prompt);

      expect(result).toEqual(['color object']);
    });
  });
});
