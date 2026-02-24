import React, { useState } from "react";
import { Modal } from "../ui/Modal";

interface WelcomeModalProps {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  title?: string;
  subtitle?: string;
  /** Label on the primary button. Defaults to "Get Started" for registration. */
  buttonLabel?: string;
}

export const WelcomeModal: React.FC<WelcomeModalProps> = ({
  open,
  onClose,
  apiKey,
  title = "Welcome to rLLM!",
  subtitle = "Your API key has been created.",
  buttonLabel = "Get Started",
}) => {
  const [copied, setCopied] = useState(false);

  const envLine = `RLLM_UI_API_KEY=${apiKey}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(envLine);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-md">
      {/* Close X button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Title */}
      <h2 className="text-lg font-bold text-gray-900 mb-3">{title}</h2>

      {/* Warning text */}
      <p className="text-sm text-gray-700 mb-1">
        This key will <strong>ONLY</strong> appear once. Make sure to copy it somewhere <em>safe</em> now.
      </p>
      <p className="text-sm text-gray-500 mb-4">{subtitle}</p>

      {/* API key display + copy */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex-1 min-w-0 px-3 py-2 bg-white border border-gray-300 rounded-lg">
          <code className="text-sm text-gray-700 truncate block">{envLine}</code>
        </div>
        <button
          onClick={handleCopy}
          className="flex-shrink-0 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      {/* Close button */}
      <button
        onClick={onClose}
        className="px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {buttonLabel}
      </button>
    </Modal>
  );
};
