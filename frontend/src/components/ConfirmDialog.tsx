import React from "react";
import { WarningIcon } from "./icons";
import { Modal } from "./ui";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}) => (
  <Modal open={open} onClose={onCancel}>
    <div className="flex items-start gap-3 mb-4">
      <div className="flex-shrink-0 w-10 h-10 bg-red-50 rounded-full flex items-center justify-center">
        <WarningIcon sx={{ fontSize: 20 }} className="text-red-500" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-500 mt-1">{message}</p>
      </div>
    </div>
    <div className="flex justify-end gap-2">
      <button
        onClick={onCancel}
        className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-layer-1 transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={onConfirm}
        className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
      >
        {confirmLabel}
      </button>
    </div>
  </Modal>
);
