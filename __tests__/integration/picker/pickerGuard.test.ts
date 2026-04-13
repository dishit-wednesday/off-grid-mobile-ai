/**
 * Integration Tests: Picker Guard
 *
 * Tests the integration between:
 * - useAttachments hook (guard logic)
 * - @react-native-documents/picker (native picker call)
 * - documentService (file processing)
 * - isPickerStuck utility (stuck-picker detection)
 * - CustomAlert (user-facing error messages)
 *
 * Verifies the in-flight guard prevents duplicate picker launches,
 * resets correctly after each call (success or error), and that
 * stuck/hung picker states surface a user-facing alert.
 */

jest.mock('../../../src/services/documentService', () => ({
  documentService: {
    isSupported: jest.fn(() => true),
    processDocumentFromPath: jest.fn(),
  },
}));

jest.mock('../../../src/components/CustomAlert', () => ({
  showAlert: jest.fn((title, message, buttons) => ({ visible: true, title, message, buttons })),
  hideAlert: jest.fn(() => ({ visible: false })),
}));

jest.mock('../../../src/theme', () => ({
  useTheme: () => ({ colors: {} }),
  useThemedStyles: () => ({}),
}));

jest.mock('../../../src/components/ChatInput/styles', () => ({
  createStyles: jest.fn(() => ({})),
}));

import { renderHook, act } from '@testing-library/react-native';
import { useAttachments } from '../../../src/components/ChatInput/Attachments';
import { documentService } from '../../../src/services/documentService';
import { showAlert } from '../../../src/components/CustomAlert';

const mockDocService = documentService as jest.Mocked<typeof documentService>;
const mockShowAlert = showAlert as jest.MockedFunction<typeof showAlert>;

// Access the globally mocked picker from jest.setup.ts
const pickerModule = require('@react-native-documents/picker');
const mockPick = pickerModule.pick as jest.MockedFunction<any>;
const mockIsErrorWithCode = pickerModule.isErrorWithCode as jest.MockedFunction<any>;

const MOCK_FILE = [{ uri: 'file:///mock/document.txt', name: 'document.txt', size: 1234 }];
const MOCK_ATTACHMENT = {
  id: 'mock-id',
  type: 'document' as const,
  uri: 'file:///mock/document.txt',
  fileName: 'document.txt',
  fileSize: 1234,
  textContent: 'hello',
};

describe('Picker Guard Integration', () => {
  let setAlertState: jest.Mock;

  beforeEach(() => {
    setAlertState = jest.fn();
    mockPick.mockResolvedValue(MOCK_FILE);
    mockDocService.processDocumentFromPath.mockResolvedValue(MOCK_ATTACHMENT as any);
    mockIsErrorWithCode.mockReturnValue(false);
  });

  // ============================================================================
  // Guard blocks concurrent calls
  // ============================================================================
  describe('in-flight guard', () => {
    it('does not call pick() a second time while first call is in flight', async () => {
      // Make pick hang indefinitely so the first call stays in-flight
      mockPick.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useAttachments(setAlertState));

      // Fire first call without awaiting — it suspends at pick()
      result.current.handlePickDocument();

      // Fire second call immediately — ref is already true, should return early
      result.current.handlePickDocument();

      expect(mockPick).toHaveBeenCalledTimes(1);
    });

    it('allows a second call once the first has fully settled (success)', async () => {
      mockPick.mockResolvedValue(MOCK_FILE);

      const { result } = renderHook(() => useAttachments(setAlertState));

      // First call completes
      await act(async () => {
        await result.current.handlePickDocument();
      });
      expect(mockPick).toHaveBeenCalledTimes(1);

      // Second call — guard was reset in finally, should proceed
      await act(async () => {
        await result.current.handlePickDocument();
      });
      expect(mockPick).toHaveBeenCalledTimes(2);
    });

    it('allows a retry after the picker threw an error', async () => {
      mockPick.mockRejectedValueOnce({ code: 'SOME_ERROR', message: 'generic error' });
      mockPick.mockResolvedValueOnce(MOCK_FILE);

      const { result } = renderHook(() => useAttachments(setAlertState));

      // First call throws
      await act(async () => {
        await result.current.handlePickDocument();
      });
      expect(mockPick).toHaveBeenCalledTimes(1);

      // Second call — guard reset in finally, should proceed
      await act(async () => {
        await result.current.handlePickDocument();
      });
      expect(mockPick).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // Stuck picker detection (isPickerStuck utility integration)
  // ============================================================================
  describe('stuck picker handling', () => {
    it('shows a user-facing alert when picker returns ASYNC_OP_IN_PROGRESS', async () => {
      mockPick.mockRejectedValue({ code: 'ASYNC_OP_IN_PROGRESS', message: '' });

      const { result } = renderHook(() => useAttachments(setAlertState));

      await act(async () => {
        await result.current.handlePickDocument();
      });

      expect(mockShowAlert).toHaveBeenCalledWith(
        'File Picker Unavailable',
        expect.stringContaining("file picker isn't responding"),
        expect.any(Array),
      );
      expect(setAlertState).toHaveBeenCalled();
    });

    it('shows alert when error message contains async_op_in_progress (case-insensitive)', async () => {
      mockPick.mockRejectedValue({ code: '', message: 'ASYNC_OP_IN_PROGRESS error' });

      const { result } = renderHook(() => useAttachments(setAlertState));

      await act(async () => {
        await result.current.handlePickDocument();
      });

      expect(mockShowAlert).toHaveBeenCalledWith(
        'File Picker Unavailable',
        expect.stringContaining("file picker isn't responding"),
        expect.any(Array),
      );
    });

    it('resets the guard after a stuck-picker error so a retry is possible', async () => {
      mockPick.mockRejectedValueOnce({ code: 'ASYNC_OP_IN_PROGRESS', message: '' });
      mockPick.mockResolvedValueOnce(MOCK_FILE);

      const { result } = renderHook(() => useAttachments(setAlertState));

      await act(async () => {
        await result.current.handlePickDocument();
      });

      // Guard must be released — second call should reach pick()
      await act(async () => {
        await result.current.handlePickDocument();
      });
      expect(mockPick).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // Cancelled pick
  // ============================================================================
  describe('cancelled pick', () => {
    it('does not show an alert when the user cancels the picker', async () => {
      mockPick.mockRejectedValue({ code: 'OPERATION_CANCELED' });
      mockIsErrorWithCode.mockReturnValue(true);

      const { result } = renderHook(() => useAttachments(setAlertState));

      await act(async () => {
        await result.current.handlePickDocument();
      });

      expect(mockShowAlert).not.toHaveBeenCalled();
      expect(setAlertState).not.toHaveBeenCalled();
    });

    it('resets the guard after a cancelled pick', async () => {
      mockPick.mockRejectedValueOnce({ code: 'OPERATION_CANCELED' });
      mockIsErrorWithCode.mockReturnValueOnce(true);
      mockPick.mockResolvedValueOnce(MOCK_FILE);

      const { result } = renderHook(() => useAttachments(setAlertState));

      await act(async () => {
        await result.current.handlePickDocument();
      });

      await act(async () => {
        await result.current.handlePickDocument();
      });
      expect(mockPick).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // Happy path
  // ============================================================================
  describe('happy path', () => {
    it('adds a document attachment on successful pick', async () => {
      const { result } = renderHook(() => useAttachments(setAlertState));

      await act(async () => {
        await result.current.handlePickDocument();
      });

      expect(mockDocService.processDocumentFromPath).toHaveBeenCalledWith(
        MOCK_FILE[0].uri,
        MOCK_FILE[0].name,
      );
      expect(result.current.attachments).toHaveLength(1);
      expect(result.current.attachments[0].fileName).toBe('document.txt');
    });

    it('shows unsupported file alert and does not add attachment', async () => {
      (mockDocService.isSupported as jest.Mock).mockReturnValue(false);

      const { result } = renderHook(() => useAttachments(setAlertState));

      await act(async () => {
        await result.current.handlePickDocument();
      });

      expect(mockDocService.processDocumentFromPath).not.toHaveBeenCalled();
      expect(result.current.attachments).toHaveLength(0);
      expect(mockShowAlert).toHaveBeenCalledWith(
        'Unsupported File',
        expect.stringContaining('not supported'),
        expect.any(Array),
      );
    });
  });
});
