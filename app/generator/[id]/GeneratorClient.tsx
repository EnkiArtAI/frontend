"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import PromptGeneratorView from "@/components/PromptGeneratorView";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function GeneratorClient() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const promptId = params.id;

  const {
    data: promptData,
    isLoading: promptLoading,
    error: promptError,
  } = useQuery<{ prompt: any }>({
    queryKey: [`/api/prompts/${promptId}`],
    enabled: !!promptId,
  });

  const prompt = promptData?.prompt;
  const creatorId = prompt?.creator?.toString?.() || prompt?.creator;

  const { data: creatorData } = useQuery<{ user: any }>({
    queryKey: [`/api/users/${creatorId}`],
    enabled: !!creatorId,
  });

  if (promptLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--pg-bg, #f7f6f1)",
          fontFamily: "'Space Mono', monospace",
          fontSize: 13,
          color: "#666",
        }}
      >
        Loading prompt...
      </div>
    );
  }

  if (promptError || !prompt) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          background: "var(--pg-bg, #f7f6f1)",
        }}
      >
        <p style={{ fontSize: 16, color: "#111" }}>Prompt not found</p>
        <Button
          onClick={() => router.push("/showcase")}
          data-testid="button-back-gallery"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Gallery
        </Button>
      </div>
    );
  }

  const promptIdString = prompt._id?.toString() || prompt.id;
  const artistName =
    creatorData?.user?.profile?.displayName ||
    creatorData?.user?.profile?.username ||
    "Unknown Artist";

  const primaryImage = prompt.showcaseImages?.find(
    (img: any) => img.isPrimary === true
  );
  const thumbnailImage = primaryImage || prompt.showcaseImages?.[0];
  const imageUrl = thumbnailImage?.thumbnail || thumbnailImage?.url || "";

  const allShowcaseImages = prompt.showcaseImages || [];
  const isFreeShowcase =
    prompt.type === "showcase" ||
    prompt.prompt_type === "showcase" ||
    prompt.is_free_showcase === true;

  return (
    <PromptGeneratorView
      promptId={promptIdString}
      title={prompt.title}
      artistName={artistName}
      artistId={creatorId}
      imageUrl={imageUrl}
      showcaseImages={allShowcaseImages}
      isFreeShowcase={isFreeShowcase}
    />
  );
}
