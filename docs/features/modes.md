# Modes


|               | Normal         | Forced charging | Forced discharging  | No battery charging | No battery discharging    |
| --------------- | -------------- | :-------------- | ------------------- | ------------------- | ------------------------- |
| Invertor mode | Self Use Mode  | Manual Mode     | Manual Mode         | Feedin Priority     | Manual Mode               |
| Manual mode   | No change      | Force Charge    | Force Discharge     | No change           | Stop Charge and Discharge |

Invertor mode entity name: `select.solax_charger_use_mode`

Available options: `Self Use Mode`, `Feedin Priority`, `Back Up Mode`, `Manual Mode`, `PeakShaving`, `Smart Schedule`

Manual mode selector entity name: `select.solax_manual_mode_select`

Available options: `Stop Charge and Discharge`, `Force Charge`, `Force Discharge`

---

## input_select proposals

### Helman mode (`input_select.helman_mode`)

| Mode                  | Proposed label (Czech)   |
| --------------------- | ------------------------ |
| Normal                | Standardní               |
| Forced charging       | Nucené nabíjení          |
| Forced discharging    | Nucené vybíjení          |
| No battery charging   | Zákaz nabíjení           |
| No battery discharging| Zákaz vybíjení           |
