import React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle } from "lucide-react";

/**
 * Replaces window.confirm() with a styled, accessible shadcn AlertDialog.
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   <ConfirmDialog open={open} onOpenChange={setOpen} title="Delete?" description="..." onConfirm={...} />
 */
export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
  testId = "confirm-dialog",
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="rounded-sm" data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-heading flex items-center gap-2">
            {destructive && <AlertTriangle className="w-5 h-5 text-rose-500" />}
            {title}
          </AlertDialogTitle>
          {description && (
            <AlertDialogDescription className="whitespace-pre-line">
              {description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid={`${testId}-cancel`} className="rounded-sm">
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid={`${testId}-confirm`}
            onClick={onConfirm}
            className={`rounded-sm ${destructive ? "bg-rose-600 hover:bg-rose-700 text-white" : "bg-[#E65100] hover:bg-[#CC4800] text-white"}`}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
