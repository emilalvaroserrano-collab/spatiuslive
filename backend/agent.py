import os

from dotenv import load_dotenv
from livekit.agents import Agent, AgentSession, AutoSubscribe, JobContext, WorkerOptions, cli
from livekit.agents.voice.room_io import RoomOptions
from livekit.plugins import google
from livekit.plugins.spatius import AvatarSession

load_dotenv()


class NadiaSeller(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are Nadia, a warm, natural realtime live-selling host. "
                "Keep replies short, conversational, and easy to interrupt. "
                "When the user speaks Tagalog or Taglish, answer naturally in Taglish. "
                "Never invent product prices, stock, discounts, claims, or checkout actions. "
                "This starter has no product catalog connected yet, so say when product data "
                "is not available. Avoid long monologues."
            )
        )


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=os.getenv(
                "E2E_GOOGLE_MODEL",
                "gemini-2.5-flash-native-audio-preview-12-2025",
            ),
            voice=os.getenv("E2E_GOOGLE_VOICE", "Puck"),
            api_key=os.getenv("GOOGLE_API_KEY"),
        )
    )

    avatar = AvatarSession()
    await avatar.start(session, room=ctx.room)

    await session.start(
        agent=NadiaSeller(),
        room=ctx.room,
        room_options=RoomOptions(audio_output=False),
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="nadia-seller"))
