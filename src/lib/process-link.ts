import { generateRecipeFromAI, getTranscription } from "@/lib/ai";
import { env } from "@/lib/constants";
import { getRecipe, postRecipe } from "@/lib/mealie";
import type { progressType, recipeResult, socialMediaResult } from "@/lib/types";
import { downloadMediaWithYtDlp } from "@/lib/yt-dlp";

export async function processSocialLink(
    url: string,
    tags: string[] = [],
    onProgress?: (progress: progressType) => void
): Promise<{ createdRecipe: recipeResult; progress: progressType }> {
    let socialMediaResult: socialMediaResult;
    let transcription = "There is not transcriptions";

    const progress: progressType = {
        videoDownloaded: null,
        audioTranscribed: null,
        recipeCreated: null,
    };

    onProgress?.(progress);

    socialMediaResult = await downloadMediaWithYtDlp(url);
    progress.videoDownloaded = true;
    onProgress?.(progress);

    if (socialMediaResult.blob) {
        transcription = await getTranscription(socialMediaResult.blob);
        progress.audioTranscribed = true;
        onProgress?.(progress);
    }

    const recipe = await generateRecipeFromAI(
        transcription,
        socialMediaResult.description,
        url,
        socialMediaResult.thumbnail,
        env.EXTRA_PROMPT || "",
        tags,
        socialMediaResult.images
    );

    console.log("Posting recipe to Mealie", recipe);
    const mealieResponse = await postRecipe(recipe);
    const createdRecipe = await getRecipe(await mealieResponse);
    console.log("Recipe created");
    progress.recipeCreated = true;
    onProgress?.(progress);

    return { createdRecipe, progress };
}
