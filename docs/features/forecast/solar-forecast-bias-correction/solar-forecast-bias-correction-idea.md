# Solar Forecast Bias Correction Idea

The solar forecast often does not match reality. Some mismatch is expected because of unexpected clouds or other changing weather conditions, but I want to reduce the impact of **repeatable systematic errors** rather than one-off weather surprises.

For example, if the upstream forecast repeatedly predicts close to 100% production for the next day, but the real production is consistently only around 50%, Helman should detect that bias and correct future forecasts accordingly. The idea is to analyze historical solar forecasts and actual solar production, find recurring discrepancies, and apply a correction that makes the forecast more realistic.

If correlating the bias with weather inputs such as temperature, rain, or similar signals helps, that can be part of the analysis as well.

The next step is to refine this idea into a well-defined requirement and brainstorm multiple approaches for how to detect the bias and apply a correction that reduces its negative impact.

---

## Status

Refined. The v1 implementation spec lives in `solar-forecast-bias-correction-v1-implementation-design.md`; companion docs in this folder cover requirements, engine architecture, model design, and the deferred Energy-platform re-exposure stub.
