"use client";

import { useState, useRef, useCallback } from "react";
import { Upload, X, ImageIcon, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { fitUpload } from "@/lib/shrink-image";

interface UploadPreview {
  file: File;
  preview: string;
  prompt?: string;
}

export default function ShowroomUploadZone() {
  const account = useActiveAccount();
  const { connected: solanaConnected } = useWallet();
  // An email login holds a session too, and the server files uploads under the session.
  const { isAuthed: emailAuthed } = useEmailAuth();
  const authenticated = emailAuthed || !!account || solanaConnected;
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [uploads, setUploads] = useState<UploadPreview[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<number, number>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;

    const newUploads: UploadPreview[] = [];
    Array.from(files).forEach((file) => {
      // Validate file type
      if (!file.type.startsWith('image/')) {
        toast({
          title: "Invalid file type",
          description: `${file.name} is not an image file`,
          variant: "destructive",
        });
        return;
      }

      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        const preview = reader.result as string;
        setUploads((prev) => {
          const existing = prev.find((u) => u.file.name === file.name);
          if (existing) return prev;
          return [...prev, { file, preview, prompt: "" }];
        });
      };
      reader.readAsDataURL(file);
    });
  }, [toast]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      e.currentTarget.classList.add('border-primary', 'bg-primary/5');
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      e.currentTarget.classList.remove('border-primary', 'bg-primary/5');
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    e.currentTarget.classList.remove('border-primary', 'bg-primary/5');

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files);
    }
  }, [handleFileSelect]);

  const removeUpload = (index: number) => {
    setUploads((prev) => prev.filter((_, i) => i !== index));
  };

  const updatePrompt = (index: number, prompt: string) => {
    setUploads((prev) => prev.map((u, i) => i === index ? { ...u, prompt } : u));
  };

  const handleUpload = async () => {
    // The server files the upload under the session's account, so a session is what it needs.
    const auth = sessionAuthHeaders();
    if (!auth["X-Session-Token"]) {
      toast({
        title: "Authentication required",
        description: "Please log in to upload images",
        variant: "destructive",
      });
      return;
    }

    if (uploads.length === 0) {
      toast({
        title: "No files selected",
        description: "Please select at least one image to upload",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    setUploadProgress({});

    const results: Array<{ success: boolean; fileName: string; error?: string }> = [];

    for (let i = 0; i < uploads.length; i++) {
      const upload = uploads[i];
      setUploadProgress((prev) => ({ ...prev, [i]: 0 }));

      try {
        // Made smaller until it arrives: Vercel turns away a body over 4.5 MB (lib/shrink-image).
        const file = await fitUpload(upload.file);
        if (!file) throw new Error(`${upload.file.name} could not be read or made small enough to upload.`);
        const formData = new FormData();
        formData.append('file', file);
        if (upload.prompt) {
          formData.append('prompt', upload.prompt);
        }

        const response = await fetch('/api/gallery/upload', {
          method: 'POST',
          headers: auth,
          body: formData,
        });

        setUploadProgress((prev) => ({ ...prev, [i]: 100 }));

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(errorData.error || `Upload failed: ${response.statusText}`);
        }

        const data = await response.json();
        results.push({ success: true, fileName: upload.file.name });
      } catch (error: any) {
        console.error(`Failed to upload ${upload.file.name}:`, error);
        results.push({
          success: false,
          fileName: upload.file.name,
          error: error.message || 'Upload failed'
        });
      }
    }

    setIsUploading(false);
    setUploadProgress({});

    // Show results
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    if (successCount > 0) {
      toast({
        title: "Upload successful",
        description: `${successCount} image(s) uploaded to your gallery`,
      });
    }

    if (failCount > 0) {
      toast({
        title: "Some uploads failed",
        // The first reason, in words: "check the console" told a user nothing.
        description: results.find((r) => !r.success)?.error ?? `${failCount} image(s) failed to upload.`,
        variant: "destructive",
      });
    }

    // Reset and close
    if (successCount > 0) {
      setUploads([]);
      setIsOpen(false);
      // Trigger gallery refresh by dispatching custom event
      window.dispatchEvent(new CustomEvent('gallery-refresh'));
    }
  };

  if (!authenticated) {
    return null;
  }

  return (
    <>
      {/* Floating Action Button */}
      <div className="fixed bottom-24 right-6 z-40">
        <Button
          onClick={() => setIsOpen(true)}
          size="lg"
          className="h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-shadow"
          data-testid="button-showroom-upload-fab"
        >
          <Upload className="h-6 w-6" />
        </Button>
      </div>

      {/* Upload Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload Images to Gallery</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Drag and Drop Zone */}
            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className="border-2 border-dashed border-border rounded-lg p-8 text-center transition-colors cursor-pointer hover:border-primary/50"
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                multiple
                className="hidden"
                onChange={(e) => handleFileSelect(e.target.files)}
                data-testid="input-file-upload"
              />
              <ImageIcon className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-sm font-medium text-foreground mb-2">
                Drag and drop images here, or click to select
              </p>
              <p className="text-xs text-muted-foreground">
                PNG, JPEG or WebP. A large image is made smaller to upload.
              </p>
            </div>

            {/* Upload Previews */}
            {uploads.length > 0 && (
              <div className="space-y-3">
                <Label className="text-sm font-semibold">Selected Images ({uploads.length})</Label>
                {uploads.map((upload, index) => (
                  <div
                    key={index}
                    className="border border-border rounded-lg p-3 space-y-2"
                    data-testid={`upload-preview-${index}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="relative w-20 h-20 rounded-md overflow-hidden bg-muted flex-shrink-0">
                        <img
                          src={upload.preview}
                          alt={upload.file.name}
                          className="w-full h-full object-cover"
                        />
                        {uploadProgress[index] !== undefined && uploadProgress[index] < 100 && (
                          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                            <div className="text-white text-xs font-semibold">
                              {uploadProgress[index]}%
                            </div>
                          </div>
                        )}
                        {uploadProgress[index] === 100 && (
                          <div className="absolute inset-0 bg-green-500/80 flex items-center justify-center">
                            <CheckCircle2 className="h-6 w-6 text-white" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-foreground truncate">
                              {upload.file.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {(upload.file.size / 1024 / 1024).toFixed(2)} MB
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 flex-shrink-0"
                            onClick={() => removeUpload(index)}
                            disabled={isUploading}
                            data-testid={`button-remove-upload-${index}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                        <div>
                          <Label htmlFor={`prompt-${index}`} className="text-xs text-muted-foreground">
                            Optional prompt/description
                          </Label>
                          <Textarea
                            id={`prompt-${index}`}
                            value={upload.prompt || ""}
                            onChange={(e) => updatePrompt(index, e.target.value)}
                            placeholder="Describe this image..."
                            className="mt-1 h-16 text-sm resize-none"
                            disabled={isUploading}
                            data-testid={`input-prompt-${index}`}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button
                variant="outline"
                onClick={() => {
                  setUploads([]);
                  setIsOpen(false);
                }}
                disabled={isUploading}
                data-testid="button-cancel-upload"
              >
                Cancel
              </Button>
              <Button
                onClick={handleUpload}
                disabled={uploads.length === 0 || isUploading}
                data-testid="button-confirm-upload"
              >
                {isUploading ? (
                  <>
                    <Upload className="h-4 w-4 mr-2 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                    Upload {uploads.length} image{uploads.length !== 1 ? 's' : ''}
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

