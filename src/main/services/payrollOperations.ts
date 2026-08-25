import type { DB } from '../db/connection'
import type { PayrollPreflight, PayrollPreflightIssue, PayrollTieOut } from '@shared/payrollOps'
import { previewRun, getRun, listEmployees } from './payroll'
import { writeAudit } from './audit'

export function payrollPreflight(db:DB,month:string,days:{employeeId:number;payableDays:number}[]):PayrollPreflight{
  const employees=listEmployees(db).filter((e)=>e.active)
  const byDays=new Map(days.map((row)=>[row.employeeId,row.payableDays]))
  const issues:PayrollPreflightIssue[]=[]
  const add=(employeeId:number|null,employeeName:string|null,category:PayrollPreflightIssue['category'],severity:PayrollPreflightIssue['severity'],message:string):void=>{issues.push({employeeId,employeeName,category,severity,message})}
  for(const employee of employees){
    const attendance=db.prepare("SELECT payable_days AS payableDays,status FROM attendance_records WHERE employee_id=? AND month=?").get(employee.id,month) as {payableDays:number;status:string}|undefined
    if(!byDays.has(employee.id)&&attendance?.status!=='approved')add(employee.id,employee.name,'attendance','error','Payable days have not been reviewed')
    if(employee.basic+employee.hra+employee.special<=0||(db.prepare('SELECT COUNT(*) AS n FROM employee_pay_heads WHERE employee_id=?').get(employee.id) as {n:number}).n===0)add(employee.id,employee.name,'salary','error','Salary structure is missing')
    if(!employee.bankAccount||!employee.bankIfsc)add(employee.id,employee.name,'bank','warning','Bank account or IFSC is missing from the payment file profile')
    if(employee.pfEnabled&&!employee.uan)add(employee.id,employee.name,'statutory','warning','UAN is missing for a PF-enabled employee')
    if(employee.esiEnabled&&!employee.esicNo)add(employee.id,employee.name,'statutory','warning','ESIC number is missing for an ESI-enabled employee')
    if(!employee.pan)add(employee.id,employee.name,'statutory','warning','PAN is missing')
  }
  let lines:ReturnType<typeof previewRun>=[]
  try{const resolved=employees.map((employee)=>({employeeId:employee.id,payableDays:byDays.get(employee.id)??(db.prepare("SELECT payable_days AS n FROM attendance_records WHERE employee_id=? AND month=? AND status='approved'").get(employee.id,month) as {n:number}|undefined)?.n??-1}));if(resolved.every((r)=>r.payableDays>=0))lines=previewRun(db,month,resolved)}catch(error){add(null,null,'attendance','error',error instanceof Error?error.message:String(error))}
  for(const line of lines)if(line.net<0)add(line.employeeId,line.employeeName,'net_pay','error','Deductions exceed earnings and produce negative net pay')
  const gross=lines.reduce((sum,line)=>sum+line.gross,0);const netPay=lines.reduce((sum,line)=>sum+line.net,0);const employerCost=lines.reduce((sum,line)=>sum+line.pfEr+line.esiEr+line.pfAdmin+line.edli,0)
  return{month,employeeCount:employees.length,gross,deductions:gross-netPay,employerCost,netPay,issues,canPost:issues.every((issue)=>issue.severity!=='error')}
}

export function payrollTieOut(db:DB,runId:number):PayrollTieOut{
  const run=getRun(db,runId);if(!run)throw new Error('Pay run not found')
  const lines=run.lines
  const sum=(pick:(line:typeof lines[number])=>number):number=>lines.reduce((total,line)=>total+pick(line),0)
  const expected=new Map<string,number>([
    ['Salaries',sum((l)=>l.gross)],['Employer PF Contribution',sum((l)=>l.pfEr)],['PF Admin & EDLI Charges',sum((l)=>l.pfAdmin+l.edli)],['Employer ESI Contribution',sum((l)=>l.esiEr)],['PF Payable',sum((l)=>l.pfEmp+l.pfEr+l.pfAdmin+l.edli)],['ESI Payable',sum((l)=>l.esiEmp+l.esiEr)],['Professional Tax Payable',sum((l)=>l.pt)],['Employee Deductions Payable',sum((l)=>l.otherDeductions)],['Salaries Payable',sum((l)=>l.net)]
  ])
  const posted=new Map<string,number>()
  if(run.voucherId){const rows=db.prepare(`SELECT l.name,vl.dr_cr AS drCr,SUM(vl.amount) AS amount FROM voucher_lines vl JOIN ledgers l ON l.id=vl.ledger_id JOIN vouchers v ON v.id=vl.voucher_id WHERE vl.voucher_id=? AND v.deleted_at IS NULL GROUP BY l.name,vl.dr_cr`).all(run.voucherId) as {name:string;drCr:'dr'|'cr';amount:number}[];for(const row of rows)posted.set(row.name,row.amount)}
  const rows=[...expected.entries()].map(([key,value])=>{const actual=posted.get(key)??0;return{key,label:key,expected:value,posted:actual,difference:actual-value}})
  const totalDifference=rows.reduce((sum,row)=>sum+Math.abs(row.difference),0)
  return{runId,month:run.month,voucherId:run.voucherId,rows,totalDifference,reconciled:!!run.voucherId&&totalDifference===0}
}

export function lockPayrollRun(db:DB,runId:number,author:string):ReturnType<typeof getRun>{const before=getRun(db,runId);if(!before)throw new Error('Pay run not found');if(before.lockedAt)throw new Error('Pay run is already locked');const tie=payrollTieOut(db,runId);if(!tie.reconciled)throw new Error('Payroll does not tie to its books voucher');db.prepare("UPDATE payroll_runs SET locked_at=datetime('now'),locked_by=? WHERE id=?").run(author,runId);const after=getRun(db,runId)!;writeAudit(db,'payroll_run',runId,'update',{lockedAt:null},{lockedAt:after.lockedAt,lockedBy:author});return after}
