import { processSocialLink } from "@/lib/process-link";
import type { progressType } from "@/lib/types";

interface RequestBody {
    url: string;
    tags: string[];
}
async function handleRequest(
    url: string,
    tags: string[],
    isSse: boolean,
    controller?: ReadableStreamDefaultController
) {
    const encoder = new TextEncoder();
    let latestProgress: progressType = {
        videoDownloaded: null,
        audioTranscribed: null,
        recipeCreated: null,
    };

    try {
        const { createdRecipe, progress: finalProgress } = await processSocialLink(
            url,
            tags,
            (updatedProgress) => {
                latestProgress = { ...updatedProgress };
                if (isSse && controller) {
                    controller.enqueue(
                        encoder.encode(
                            `data: ${JSON.stringify({ progress: latestProgress })}\n\n`
                        )
                    );
                }
            }
        );
        if (isSse && controller) {
            latestProgress = finalProgress;
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ progress: latestProgress })}\n\n`)
            );
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(createdRecipe)}\n\n`)
            );
            controller.close();
            return;
        }
        return new Response(JSON.stringify({ createdRecipe, progress: finalProgress }), {
            status: 200,
        });
    } catch (error: any) {
        const failedProgress = {
            ...latestProgress,
            recipeCreated: false,
        };
        if (isSse && controller) {
            controller.enqueue(
                encoder.encode(
                    `data: ${JSON.stringify({
                        error: error.message,
                        progress: failedProgress,
                    })}\n\n`
                )
            );
            controller.close();
            return;
        }
        return new Response(
            JSON.stringify({ error: error.message, progress: failedProgress }),
            { status: 500 }
        );
    }
}

export async function POST(req: Request) {
    const body: RequestBody = await req.json();
    const url = body.url;
    const tags = body.tags;
    const contentType = req.headers.get("Content-Type");

    if (contentType === "text/event-stream") {
        const stream = new ReadableStream({
            async start(controller) {
                await handleRequest(url, tags, true, controller);
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        });
    }
    return handleRequest(url, tags, false);
}
