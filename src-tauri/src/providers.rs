use crate::models::ProviderDefinition;

pub fn simple_key_providers() -> Vec<ProviderDefinition> {
    vec![
        provider("anthropic", "Anthropic", "ANTHROPIC_API_KEY", "sk-ant-…"),
        provider("ant-ling", "Ant Ling", "ANT_LING_API_KEY", "Key"),
        provider("openai", "OpenAI", "OPENAI_API_KEY", "sk-…"),
        provider("deepseek", "DeepSeek", "DEEPSEEK_API_KEY", "sk-…"),
        provider("nvidia", "NVIDIA NIM", "NVIDIA_API_KEY", "nvapi-…"),
        provider("google", "Google Gemini", "GEMINI_API_KEY", "Key"),
        provider(
            "amazon-bedrock",
            "Amazon Bedrock",
            "AWS_BEARER_TOKEN_BEDROCK",
            "Bearer token",
        ),
        provider("mistral", "Mistral", "MISTRAL_API_KEY", "Key"),
        provider("groq", "Groq", "GROQ_API_KEY", "gsk_…"),
        provider("cerebras", "Cerebras", "CEREBRAS_API_KEY", "csk-…"),
        provider("xai", "xAI", "XAI_API_KEY", "xai-…"),
        provider("openrouter", "OpenRouter", "OPENROUTER_API_KEY", "sk-or-…"),
        provider(
            "vercel-ai-gateway",
            "Vercel AI Gateway",
            "AI_GATEWAY_API_KEY",
            "Key",
        ),
        provider("zai", "ZAI Coding Plan", "ZAI_API_KEY", "Key"),
        provider(
            "zai-coding-cn",
            "ZAI Coding Plan China",
            "ZAI_CODING_CN_API_KEY",
            "Key",
        ),
        provider("opencode", "OpenCode Zen", "OPENCODE_API_KEY", "Key"),
        provider("opencode-go", "OpenCode Go", "OPENCODE_API_KEY", "Key"),
        provider("radius", "Radius", "RADIUS_API_KEY", "Key"),
        provider("huggingface", "Hugging Face", "HF_TOKEN", "hf_…"),
        provider("fireworks", "Fireworks", "FIREWORKS_API_KEY", "Key"),
        provider("together", "Together AI", "TOGETHER_API_KEY", "Key"),
        provider("kimi-coding", "Kimi For Coding", "KIMI_API_KEY", "Key"),
        provider("minimax", "MiniMax", "MINIMAX_API_KEY", "Key"),
        provider("minimax-cn", "MiniMax China", "MINIMAX_CN_API_KEY", "Key"),
        provider("xiaomi", "Xiaomi MiMo", "XIAOMI_API_KEY", "Key"),
        provider(
            "xiaomi-token-plan-cn",
            "Xiaomi Token Plan China",
            "XIAOMI_TOKEN_PLAN_CN_API_KEY",
            "Key",
        ),
        provider(
            "xiaomi-token-plan-ams",
            "Xiaomi Token Plan Amsterdam",
            "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
            "Key",
        ),
        provider(
            "xiaomi-token-plan-sgp",
            "Xiaomi Token Plan Singapore",
            "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
            "Key",
        ),
    ]
}

const fn provider(
    id: &'static str,
    name: &'static str,
    environment_variable: &'static str,
    placeholder: &'static str,
) -> ProviderDefinition {
    ProviderDefinition {
        id,
        name,
        environment_variable,
        placeholder,
    }
}
