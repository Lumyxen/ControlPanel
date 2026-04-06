#pragma once
// backend/include/services/llama_api.h
//
// A struct of function pointers covering every llama.cpp C-API symbol used by
// LlamaCppService. Populated at runtime via dlsym() after dlopen()ing one of
// the backend shared libs in data/libs/.
//
// Using a table of pointers rather than direct symbol references means:
//   - The main binary has zero link-time dependency on llama.cpp.
//   - Multiple backends can exist as separate .so files without symbol conflicts.
//   - Swapping backends at runtime is safe: just swap the table + reload the model.

#ifdef __cplusplus
extern "C" {
#endif

// Pull in llama.cpp type definitions from the *header only* (no linking).
// The headers are vendored / fetched by build_backend.sh alongside each .so.
// For the main binary we need the types but not the symbols.
#include "llama.h"
#include "ggml-backend.h"

#ifdef __cplusplus
}
#endif

// Every function we call from llama.cpp goes in here.
// Add new entries here if LlamaCppService starts using additional API functions.
struct LlamaApi {

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    void          (*backend_init)               ()                                                 = nullptr;
    void          (*backend_free)               ()                                                 = nullptr;
    void          (*log_set)                    (ggml_log_callback cb, void* data)                 = nullptr;

    // ── Model ─────────────────────────────────────────────────────────────────
    llama_model_params (*model_default_params)  ()                                                 = nullptr;
    llama_model*  (*model_load_from_file)       (const char* path, llama_model_params p)           = nullptr;
    void          (*model_free)                 (llama_model* m)                                   = nullptr;
    const llama_vocab* (*model_get_vocab)       (const llama_model* m)                             = nullptr;

    // ── Context ───────────────────────────────────────────────────────────────
    llama_context_params (*context_default_params) ()                                              = nullptr;
    llama_context* (*init_from_model)           (llama_model* m, llama_context_params p)           = nullptr;
    void          (*free)                       (llama_context* ctx)                               = nullptr;

    // ── Inference ─────────────────────────────────────────────────────────────
    llama_batch   (*batch_init)                 (int32_t n_tokens, int32_t embd, int32_t n_seq_max) = nullptr;
    void          (*batch_free)                 (llama_batch batch)                                = nullptr;
    int32_t       (*decode)                     (llama_context* ctx, llama_batch batch)            = nullptr;

    // ── Memory ────────────────────────────────────────────────────────────────
    llama_memory_t (*get_memory)                (llama_context* ctx)                               = nullptr;
    void          (*memory_clear)               (llama_memory_t mem, bool data)                    = nullptr;
    
    // We declare these as returning void so we don't accidentally read garbage
    // or trigger false-failures if the library returns false on partial trims.
    void          (*memory_seq_rm)              (llama_memory_t mem, llama_seq_id seq_id, llama_pos p0, llama_pos p1) = nullptr;
    void          (*kv_cache_seq_rm)            (llama_context* ctx, llama_seq_id seq_id, llama_pos p0, llama_pos p1) = nullptr;
    void          (*kv_cache_clear)             (llama_context* ctx)                               = nullptr;

    // Optional — needed in older versions to flush M-RoPE's internal position-max
    // tracker after a partial KV cache trim via memory_seq_rm.
    void          (*kv_cache_defrag)            (llama_context* ctx)                               = nullptr;
    void          (*kv_cache_update)            (llama_context* ctx)                               = nullptr;

    // ── Tokenisation ──────────────────────────────────────────────────────────
    int32_t       (*tokenize)                   (const llama_vocab* vocab,
                                                 const char* text, int32_t text_len,
                                                 llama_token* tokens, int32_t n_tokens_max,
                                                 bool add_special, bool parse_special)             = nullptr;
    int32_t       (*token_to_piece)             (const llama_vocab* vocab,
                                                 llama_token token, char* buf, int32_t length,
                                                 int32_t lstrip, bool special)                     = nullptr;
    bool          (*vocab_is_eog)               (const llama_vocab* vocab, llama_token token)      = nullptr;
    int32_t       (*chat_apply_template)        (const llama_model* model,
                                                 const llama_chat_message* chat,
                                                 size_t n_msg, bool add_ass,
                                                 char* buf, int32_t length)                        = nullptr;

    // ── Samplers ─────────────────────────────────────────────────────────────
    llama_sampler_chain_params (*sampler_chain_default_params) ()                                  = nullptr;
    llama_sampler* (*sampler_chain_init)        (llama_sampler_chain_params p)                     = nullptr;
    void          (*sampler_chain_add)          (llama_sampler* chain, llama_sampler* smpl)        = nullptr;
    llama_sampler* (*sampler_init_penalties)    (int32_t n_vocab, float penalty_repeat,
                                                 float penalty_freq, float penalty_present)        = nullptr;
    llama_sampler* (*sampler_init_top_p)        (float p, size_t min_keep)                         = nullptr;
    llama_sampler* (*sampler_init_min_p)        (float p, size_t min_keep)                         = nullptr;
    llama_sampler* (*sampler_init_temp)         (float t)                                          = nullptr;
    llama_sampler* (*sampler_init_dist)         (uint32_t seed)                                    = nullptr;
    llama_token   (*sampler_sample)             (llama_sampler* smpl, llama_context* ctx,
                                                 int32_t idx)                                      = nullptr;
    void          (*sampler_free)               (llama_sampler* smpl)                              = nullptr;

    // ── GGML backend enumeration (runtime hardware detection) ─────────────────
    size_t        (*ggml_backend_reg_count)     ()                                                 = nullptr;
    ggml_backend_reg_t (*ggml_backend_reg_get)  (size_t index)                                    = nullptr;
    const char*   (*ggml_backend_reg_name)      (ggml_backend_reg_t reg)                           = nullptr;

    // ── true once all pointers have been resolved successfully ────────────────
    bool loaded = false;
};
