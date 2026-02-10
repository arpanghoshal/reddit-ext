-- Migration 014: Add business_context column to user_settings
-- Stores free-form context about the business for richer AI message generation

ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS business_context text;
